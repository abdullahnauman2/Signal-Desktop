// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ipcRenderer } from 'electron';
import type { ThunkAction, ThunkDispatch } from 'redux-thunk';
import {
  hasScreenCapturePermission,
  openSystemPreferences,
} from 'mac-screen-capture-permissions';
import { omit } from 'lodash';
import type { ReadonlyDeep } from 'type-fest';
import {
  CallLinkRootKey,
  GroupCallEndReason,
  type Reaction as CallReaction,
} from '@signalapp/ringrtc';
import { getOwn } from '../../util/getOwn';
import * as Errors from '../../types/errors';
import { getIntl, getPlatform } from '../selectors/user';
import { isConversationTooBigToRing } from '../../conversations/isConversationTooBigToRing';
import { missingCaseError } from '../../util/missingCaseError';
import { drop } from '../../util/drop';
import { calling } from '../../services/calling';
import { truncateAudioLevel } from '../../calling/truncateAudioLevel';
import type { StateType as RootStateType } from '../reducer';
import type {
  ActiveCallReaction,
  ActiveCallReactionsType,
  ChangeIODevicePayloadType,
  GroupCallVideoRequest,
  MediaDeviceSettings,
  PresentedSource,
  PresentableSource,
} from '../../types/Calling';
import type { CallLinkRestrictions } from '../../types/CallLink';
import {
  CALLING_REACTIONS_LIFETIME,
  MAX_CALLING_REACTIONS,
  CallEndedReason,
  CallingDeviceType,
  CallMode,
  CallViewMode,
  CallState,
  GroupCallConnectionState,
  GroupCallJoinState,
} from '../../types/Calling';
import { callingTones } from '../../util/callingTones';
import { requestCameraPermissions } from '../../util/callingPermissions';
import { getRoomIdFromRootKey } from '../../util/callLinks';
import { sleep } from '../../util/sleep';
import { LatestQueue } from '../../util/LatestQueue';
import type { AciString } from '../../types/ServiceId';
import type {
  ConversationChangedActionType,
  ConversationRemovedActionType,
} from './conversations';
import { getConversationCallMode, updateLastMessage } from './conversations';
import * as log from '../../logging/log';
import { strictAssert } from '../../util/assert';
import { waitForOnline } from '../../util/waitForOnline';
import * as mapUtil from '../../util/mapUtil';
import { isCallSafe } from '../../util/isCallSafe';
import { isDirectConversation } from '../../util/whatTypeOfConversation';
import { SHOW_TOAST } from './toast';
import { ToastType } from '../../types/Toast';
import type { ShowToastActionType } from './toast';
import type { BoundActionCreatorsMapObject } from '../../hooks/useBoundActions';
import { useBoundActions } from '../../hooks/useBoundActions';
import { isAnybodyElseInGroupCall } from './callingHelpers';
import { SafetyNumberChangeSource } from '../../components/SafetyNumberChangeDialog';
import {
  isGroupOrAdhocCallMode,
  isGroupOrAdhocCallState,
} from '../../util/isGroupOrAdhocCall';
import type { ShowErrorModalActionType } from './globalModals';
import { SHOW_ERROR_MODAL } from './globalModals';
import { ButtonVariant } from '../../components/Button';
import { getConversationIdForLogging } from '../../util/idForLogging';
import dataInterface from '../../sql/Client';

// State

export type GroupCallPeekInfoType = ReadonlyDeep<{
  acis: Array<AciString>;
  creatorAci?: AciString;
  eraId?: string;
  maxDevices: number;
  deviceCount: number;
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type GroupCallParticipantInfoType = {
  aci: AciString;
  addedTime?: number;
  demuxId: number;
  hasRemoteAudio: boolean;
  hasRemoteVideo: boolean;
  mediaKeysReceived: boolean;
  presenting: boolean;
  sharingScreen: boolean;
  speakerTime?: number;
  videoAspectRatio: number;
};

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type DirectCallStateType = {
  callMode: CallMode.Direct;
  conversationId: string;
  callState?: CallState;
  callEndedReason?: CallEndedReason;
  isIncoming: boolean;
  isSharingScreen?: boolean;
  isVideoCall: boolean;
  hasRemoteVideo?: boolean;
};

type GroupCallRingStateType = ReadonlyDeep<
  | {
      ringId?: undefined;
      ringerAci?: undefined;
    }
  | {
      ringId: bigint;
      ringerAci: AciString;
    }
>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type GroupCallStateType = {
  callMode: CallMode.Group | CallMode.Adhoc;
  conversationId: string;
  connectionState: GroupCallConnectionState;
  localDemuxId: number | undefined;
  joinState: GroupCallJoinState;
  peekInfo?: GroupCallPeekInfoType;
  raisedHands?: Array<number>;
  remoteParticipants: Array<GroupCallParticipantInfoType>;
  remoteAudioLevels?: Map<number, number>;
} & GroupCallRingStateType;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type ActiveCallStateType = {
  callMode: CallMode;
  conversationId: string;
  hasLocalAudio: boolean;
  hasLocalVideo: boolean;
  localAudioLevel: number;
  viewMode: CallViewMode;
  viewModeBeforePresentation?: CallViewMode;
  joinedAt: number | null;
  outgoingRing: boolean;
  pip: boolean;
  presentingSource?: PresentedSource;
  presentingSourcesAvailable?: Array<PresentableSource>;
  settingsDialogOpen: boolean;
  showNeedsScreenRecordingPermissionsWarning?: boolean;
  showParticipantsList: boolean;
  reactions?: ActiveCallReactionsType;
};

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type CallsByConversationType = {
  [conversationId: string]: DirectCallStateType | GroupCallStateType;
};

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type AdhocCallsType = {
  [roomId: string]: GroupCallStateType;
};

export type CallLinkStateType = ReadonlyDeep<{
  name: string;
  restrictions: CallLinkRestrictions;
  expiration: number | null;
  revoked: boolean;
}>;

export type CallLinksByRoomIdStateType = ReadonlyDeep<
  CallLinkStateType & {
    rootKey: string;
    adminKey: string | null;
  }
>;

export type CallLinksByRoomIdType = ReadonlyDeep<{
  [roomId: string]: CallLinksByRoomIdStateType;
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type CallingStateType = MediaDeviceSettings & {
  callsByConversation: CallsByConversationType;
  adhocCalls: AdhocCallsType;
  callLinks: CallLinksByRoomIdType;
  activeCallState?: ActiveCallStateType;
};

export type AcceptCallType = ReadonlyDeep<{
  conversationId: string;
  asVideoCall: boolean;
}>;

export type CallStateChangeType = ReadonlyDeep<{
  conversationId: string;
  acceptedTime: number | null;
  callState: CallState;
  callEndedReason?: CallEndedReason;
}>;

export type CancelCallType = ReadonlyDeep<{
  conversationId: string;
}>;

type CancelIncomingGroupCallRingType = ReadonlyDeep<{
  conversationId: string;
  ringId: bigint;
}>;

export type DeclineCallType = ReadonlyDeep<{
  conversationId: string;
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
type GroupCallStateChangeArgumentType = {
  callMode: CallMode.Group | CallMode.Adhoc;
  connectionState: GroupCallConnectionState;
  conversationId: string;
  hasLocalAudio: boolean;
  hasLocalVideo: boolean;
  joinState: GroupCallJoinState;
  localDemuxId: number | undefined;
  peekInfo?: GroupCallPeekInfoType;
  remoteParticipants: Array<GroupCallParticipantInfoType>;
};

type GroupCallReactionsReceivedArgumentType = ReadonlyDeep<{
  callMode: CallMode;
  conversationId: string;
  reactions: Array<CallReaction>;
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
type GroupCallStateChangeActionPayloadType =
  GroupCallStateChangeArgumentType & {
    ourAci: AciString;
  };

type HangUpActionPayloadType = ReadonlyDeep<{
  conversationId: string;
}>;

export type IncomingDirectCallType = ReadonlyDeep<{
  conversationId: string;
  isVideoCall: boolean;
}>;

type IncomingGroupCallType = ReadonlyDeep<{
  conversationId: string;
  ringId: bigint;
  ringerAci: AciString;
}>;

export type SendGroupCallRaiseHandType = ReadonlyDeep<{
  conversationId: string;
  raise: boolean;
}>;

export type SendGroupCallReactionType = ReadonlyDeep<{
  callMode: CallMode;
  conversationId: string;
  value: string;
}>;
type SendGroupCallReactionLocalCopyType = ReadonlyDeep<{
  callMode: CallMode;
  conversationId: string;
  value: string;
  timestamp: number;
}>;

type PeekNotConnectedGroupCallType = ReadonlyDeep<{
  conversationId: string;
}>;

type StartDirectCallType = ReadonlyDeep<{
  conversationId: string;
  hasLocalAudio: boolean;
  hasLocalVideo: boolean;
}>;

export type StartCallType = ReadonlyDeep<
  StartDirectCallType & {
    callMode: CallMode.Direct | CallMode.Group | CallMode.Adhoc;
  }
>;

export type RemoteVideoChangeType = ReadonlyDeep<{
  conversationId: string;
  hasVideo: boolean;
}>;

type RemoteSharingScreenChangeType = ReadonlyDeep<{
  conversationId: string;
  isSharingScreen: boolean;
}>;

export type SetLocalAudioType = ReadonlyDeep<{
  enabled: boolean;
}>;

export type SetLocalVideoType = ReadonlyDeep<{
  enabled: boolean;
}>;

export type SetGroupCallVideoRequestType = ReadonlyDeep<{
  conversationId: string;
  resolutions: Array<GroupCallVideoRequest>;
  speakerHeight: number;
}>;

export type StartCallingLobbyType = ReadonlyDeep<{
  conversationId: string;
  isVideoCall: boolean;
}>;

export type StartCallLinkLobbyType = ReadonlyDeep<{
  rootKey: string;
}>;

export type StartCallLinkLobbyByRoomIdType = ReadonlyDeep<{
  roomId: string;
}>;

type StartCallLinkLobbyThunkActionType = ReadonlyDeep<
  ThunkAction<
    void,
    RootStateType,
    unknown,
    StartCallLinkLobbyActionType | ShowErrorModalActionType
  >
>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
type StartCallingLobbyPayloadType =
  | {
      callMode: CallMode.Direct;
      conversationId: string;
      hasLocalAudio: boolean;
      hasLocalVideo: boolean;
    }
  | {
      callMode: CallMode.Group;
      conversationId: string;
      connectionState: GroupCallConnectionState;
      joinState: GroupCallJoinState;
      hasLocalAudio: boolean;
      hasLocalVideo: boolean;
      isConversationTooBigToRing: boolean;
      peekInfo?: GroupCallPeekInfoType;
      remoteParticipants: Array<GroupCallParticipantInfoType>;
    };

// eslint-disable-next-line local-rules/type-alias-readonlydeep
type StartCallLinkLobbyPayloadType = {
  callMode: CallMode.Adhoc;
  conversationId: string;
  connectionState: GroupCallConnectionState;
  joinState: GroupCallJoinState;
  hasLocalAudio: boolean;
  hasLocalVideo: boolean;
  isConversationTooBigToRing: boolean;
  peekInfo?: GroupCallPeekInfoType;
  remoteParticipants: Array<GroupCallParticipantInfoType>;
  callLinkState: CallLinkStateType;
  callLinkRootKey: string;
};

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type SetLocalPreviewType = {
  element: React.RefObject<HTMLVideoElement> | undefined;
};

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type SetRendererCanvasType = {
  element: React.RefObject<HTMLCanvasElement> | undefined;
};

// Helpers

export const getActiveCall = ({
  activeCallState,
  adhocCalls,
  callsByConversation,
}: CallingStateType): undefined | DirectCallStateType | GroupCallStateType => {
  if (!activeCallState) {
    return;
  }

  const { callMode, conversationId } = activeCallState;
  return callMode === CallMode.Adhoc
    ? getOwn(adhocCalls, conversationId)
    : getOwn(callsByConversation, conversationId);
};

const getGroupCallRingState = (
  call: Readonly<undefined | GroupCallStateType>
): GroupCallRingStateType =>
  call?.ringId === undefined
    ? {}
    : { ringId: call.ringId, ringerAci: call.ringerAci };

// We might call this function many times in rapid succession (for example, if lots of
//   people are joining and leaving at once). We want to make sure to update eventually
//   (if people join and leave for an hour, we don't want you to have to wait an hour to
//   get an update), and we also don't want to update too often. That's why we use a
//   "latest queue".
const peekQueueByConversation = new Map<string, LatestQueue>();
const doGroupCallPeek = ({
  conversationId,
  callMode,
  dispatch,
  getState,
}: {
  conversationId: string;
  callMode: CallMode.Group | CallMode.Adhoc;
  dispatch: ThunkDispatch<
    RootStateType,
    unknown,
    PeekGroupCallFulfilledActionType
  >;
  getState: () => RootStateType;
}) => {
  let logId: string;
  if (callMode === CallMode.Group) {
    const conversation = getOwn(
      getState().conversations.conversationLookup,
      conversationId
    );
    if (
      !conversation ||
      getConversationCallMode(conversation) !== CallMode.Group
    ) {
      return;
    }

    logId = getConversationIdForLogging(conversation);
  } else {
    const callLink = getOwn(getState().calling.callLinks, conversationId);
    if (!callLink) {
      return;
    }
    logId = `adhoc(${conversationId})`;
  }

  let queue = peekQueueByConversation.get(conversationId);
  if (!queue) {
    queue = new LatestQueue();
    queue.onceEmpty(() => {
      peekQueueByConversation.delete(conversationId);
    });
    peekQueueByConversation.set(conversationId, queue);
  }

  queue.add(async () => {
    const state = getState();

    // We make sure we're not trying to peek at a connected (or connecting, or
    //   reconnecting) call. Because this is asynchronous, it's possible that the call
    //   will connect by the time we dispatch, so we also need to do a similar check in
    //   the reducer.
    const existingCall = getOwn(
      state.calling.callsByConversation,
      conversationId
    );
    if (
      existingCall != null &&
      isGroupOrAdhocCallState(existingCall) &&
      existingCall.connectionState !== GroupCallConnectionState.NotConnected
    ) {
      log.info(
        `doGroupCallPeek/groupv2: Not peeking because the connection state is ${existingCall.connectionState}`
      );
      return;
    }

    // If we peek right after receiving the message, we may get outdated information.
    //   This is most noticeable when someone leaves. We add a delay and then make sure
    //   to only be peeking once.
    const { server } = window.textsecure;
    if (!server) {
      log.error('doGroupCallPeek: no textsecure server');
      return;
    }
    await Promise.all([sleep(1000), waitForOnline()]);

    let peekInfo = null;
    try {
      if (callMode === CallMode.Group) {
        peekInfo = await calling.peekGroupCall(conversationId);
      } else {
        // For adhoc calls, conversationId is actually a roomId.
        const rootKey: string | undefined = getOwn(
          state.calling.callLinks,
          conversationId
        )?.rootKey;
        peekInfo = await calling.peekCallLinkCall(conversationId, rootKey);
      }
    } catch (err) {
      log.error('Group call peeking failed', Errors.toLogFormat(err));
      return;
    }

    if (!peekInfo) {
      return;
    }

    log.info(`doGroupCallPeek/${logId}: Found ${peekInfo.deviceCount} devices`);

    if (callMode === CallMode.Group) {
      const joinState = isGroupOrAdhocCallState(existingCall)
        ? existingCall.joinState
        : null;

      try {
        await calling.updateCallHistoryForGroupCallOnPeek(
          conversationId,
          joinState,
          peekInfo
        );
      } catch (error) {
        log.error(
          'doGroupCallPeek/groupv2: Failed to update call history',
          Errors.toLogFormat(error)
        );
      }

      dispatch(updateLastMessage(conversationId));
    }

    const formattedPeekInfo = calling.formatGroupCallPeekInfoForRedux(peekInfo);

    dispatch({
      type: PEEK_GROUP_CALL_FULFILLED,
      payload: {
        callMode,
        conversationId,
        peekInfo: formattedPeekInfo,
      },
    });
  });
};

// Actions

const ACCEPT_CALL_PENDING = 'calling/ACCEPT_CALL_PENDING';
const CANCEL_CALL = 'calling/CANCEL_CALL';
const CANCEL_INCOMING_GROUP_CALL_RING =
  'calling/CANCEL_INCOMING_GROUP_CALL_RING';
const CHANGE_CALL_VIEW = 'calling/CHANGE_CALL_VIEW';
const START_CALLING_LOBBY = 'calling/START_CALLING_LOBBY';
const START_CALL_LINK_LOBBY = 'calling/START_CALL_LINK_LOBBY';
const CALL_STATE_CHANGE_FULFILLED = 'calling/CALL_STATE_CHANGE_FULFILLED';
const CHANGE_IO_DEVICE_FULFILLED = 'calling/CHANGE_IO_DEVICE_FULFILLED';
const CLOSE_NEED_PERMISSION_SCREEN = 'calling/CLOSE_NEED_PERMISSION_SCREEN';
const DECLINE_DIRECT_CALL = 'calling/DECLINE_DIRECT_CALL';
const GROUP_CALL_AUDIO_LEVELS_CHANGE = 'calling/GROUP_CALL_AUDIO_LEVELS_CHANGE';
const GROUP_CALL_ENDED = 'calling/GROUP_CALL_ENDED';
const GROUP_CALL_RAISED_HANDS_CHANGE = 'calling/GROUP_CALL_RAISED_HANDS_CHANGE';
const GROUP_CALL_STATE_CHANGE = 'calling/GROUP_CALL_STATE_CHANGE';
const GROUP_CALL_REACTIONS_RECEIVED = 'calling/GROUP_CALL_REACTIONS_RECEIVED';
const GROUP_CALL_REACTIONS_EXPIRED = 'calling/GROUP_CALL_REACTIONS_EXPIRED';
const HANG_UP = 'calling/HANG_UP';
const INCOMING_DIRECT_CALL = 'calling/INCOMING_DIRECT_CALL';
const INCOMING_GROUP_CALL = 'calling/INCOMING_GROUP_CALL';
const OUTGOING_CALL = 'calling/OUTGOING_CALL';
const PEEK_GROUP_CALL_FULFILLED = 'calling/PEEK_GROUP_CALL_FULFILLED';
const RAISE_HAND_GROUP_CALL = 'calling/RAISE_HAND_GROUP_CALL';
const REFRESH_IO_DEVICES = 'calling/REFRESH_IO_DEVICES';
const REMOTE_SHARING_SCREEN_CHANGE = 'calling/REMOTE_SHARING_SCREEN_CHANGE';
const REMOTE_VIDEO_CHANGE = 'calling/REMOTE_VIDEO_CHANGE';
const RETURN_TO_ACTIVE_CALL = 'calling/RETURN_TO_ACTIVE_CALL';
const SEND_GROUP_CALL_REACTION = 'calling/SEND_GROUP_CALL_REACTION';
const SET_LOCAL_AUDIO_FULFILLED = 'calling/SET_LOCAL_AUDIO_FULFILLED';
const SET_LOCAL_VIDEO_FULFILLED = 'calling/SET_LOCAL_VIDEO_FULFILLED';
const SET_OUTGOING_RING = 'calling/SET_OUTGOING_RING';
const SET_PRESENTING = 'calling/SET_PRESENTING';
const SET_PRESENTING_SOURCES = 'calling/SET_PRESENTING_SOURCES';
const TOGGLE_NEEDS_SCREEN_RECORDING_PERMISSIONS =
  'calling/TOGGLE_NEEDS_SCREEN_RECORDING_PERMISSIONS';
const START_DIRECT_CALL = 'calling/START_DIRECT_CALL';
const TOGGLE_PARTICIPANTS = 'calling/TOGGLE_PARTICIPANTS';
const TOGGLE_PIP = 'calling/TOGGLE_PIP';
const TOGGLE_SETTINGS = 'calling/TOGGLE_SETTINGS';
const SWITCH_TO_PRESENTATION_VIEW = 'calling/SWITCH_TO_PRESENTATION_VIEW';
const SWITCH_FROM_PRESENTATION_VIEW = 'calling/SWITCH_FROM_PRESENTATION_VIEW';

type AcceptCallPendingActionType = ReadonlyDeep<{
  type: 'calling/ACCEPT_CALL_PENDING';
  payload: AcceptCallType;
}>;

type CancelCallActionType = ReadonlyDeep<{
  type: 'calling/CANCEL_CALL';
}>;

type CancelIncomingGroupCallRingActionType = ReadonlyDeep<{
  type: 'calling/CANCEL_INCOMING_GROUP_CALL_RING';
  payload: CancelIncomingGroupCallRingType;
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
type StartCallingLobbyActionType = {
  type: 'calling/START_CALLING_LOBBY';
  payload: StartCallingLobbyPayloadType;
};

// eslint-disable-next-line local-rules/type-alias-readonlydeep
type StartCallLinkLobbyActionType = {
  type: 'calling/START_CALL_LINK_LOBBY';
  payload: StartCallLinkLobbyPayloadType;
};

type CallStateChangeFulfilledActionType = ReadonlyDeep<{
  type: 'calling/CALL_STATE_CHANGE_FULFILLED';
  payload: CallStateChangeType;
}>;

type ChangeIODeviceFulfilledActionType = ReadonlyDeep<{
  type: 'calling/CHANGE_IO_DEVICE_FULFILLED';
  payload: ChangeIODevicePayloadType;
}>;

type CloseNeedPermissionScreenActionType = ReadonlyDeep<{
  type: 'calling/CLOSE_NEED_PERMISSION_SCREEN';
  payload: null;
}>;

type DeclineCallActionType = ReadonlyDeep<{
  type: 'calling/DECLINE_DIRECT_CALL';
  payload: DeclineCallType;
}>;

type GroupCallAudioLevelsChangeActionPayloadType = ReadonlyDeep<{
  callMode: CallMode;
  conversationId: string;
  localAudioLevel: number;
  remoteDeviceStates: ReadonlyArray<{ audioLevel: number; demuxId: number }>;
}>;

type GroupCallAudioLevelsChangeActionType = ReadonlyDeep<{
  type: 'calling/GROUP_CALL_AUDIO_LEVELS_CHANGE';
  payload: GroupCallAudioLevelsChangeActionPayloadType;
}>;

type GroupCallEndedActionPayloadType = ReadonlyDeep<{
  conversationId: string;
  endedReason: GroupCallEndReason;
}>;

export type GroupCallEndedActionType = ReadonlyDeep<{
  type: 'calling/GROUP_CALL_ENDED';
  payload: GroupCallEndedActionPayloadType;
}>;

type GroupCallRaisedHandsChangeActionPayloadType = ReadonlyDeep<{
  callMode: CallMode;
  conversationId: string;
  raisedHands: ReadonlyArray<number>;
}>;

type GroupCallRaisedHandsChangeActionType = ReadonlyDeep<{
  type: 'calling/GROUP_CALL_RAISED_HANDS_CHANGE';
  payload: GroupCallRaisedHandsChangeActionPayloadType;
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type GroupCallStateChangeActionType = {
  type: 'calling/GROUP_CALL_STATE_CHANGE';
  payload: GroupCallStateChangeActionPayloadType;
};

type GroupCallReactionsReceivedActionPayloadType = ReadonlyDeep<{
  callMode: CallMode;
  conversationId: string;
  reactions: Array<CallReaction>;
  timestamp: number;
}>;

type GroupCallReactionsExpiredActionPayloadType = ReadonlyDeep<{
  conversationId: string;
  timestamp: number;
}>;

export type GroupCallReactionsReceivedActionType = ReadonlyDeep<{
  type: 'calling/GROUP_CALL_REACTIONS_RECEIVED';
  payload: GroupCallReactionsReceivedActionPayloadType;
}>;

type GroupCallReactionsExpiredActionType = ReadonlyDeep<{
  type: 'calling/GROUP_CALL_REACTIONS_EXPIRED';
  payload: GroupCallReactionsExpiredActionPayloadType;
}>;

type HangUpActionType = ReadonlyDeep<{
  type: 'calling/HANG_UP';
  payload: HangUpActionPayloadType;
}>;

type IncomingDirectCallActionType = ReadonlyDeep<{
  type: 'calling/INCOMING_DIRECT_CALL';
  payload: IncomingDirectCallType;
}>;

type IncomingGroupCallActionType = ReadonlyDeep<{
  type: 'calling/INCOMING_GROUP_CALL';
  payload: IncomingGroupCallType;
}>;

type SendGroupCallRaiseHandActionType = ReadonlyDeep<{
  type: 'calling/RAISE_HAND_GROUP_CALL';
  payload: SendGroupCallRaiseHandType;
}>;

export type SendGroupCallReactionActionType = ReadonlyDeep<{
  type: 'calling/SEND_GROUP_CALL_REACTION';
  payload: SendGroupCallReactionLocalCopyType;
}>;

type OutgoingCallActionType = ReadonlyDeep<{
  type: 'calling/OUTGOING_CALL';
  payload: StartDirectCallType;
}>;

export type PeekGroupCallFulfilledActionType = ReadonlyDeep<{
  type: 'calling/PEEK_GROUP_CALL_FULFILLED';
  payload: {
    callMode: CallMode;
    conversationId: string;
    peekInfo: GroupCallPeekInfoType;
  };
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
type RefreshIODevicesActionType = {
  type: 'calling/REFRESH_IO_DEVICES';
  payload: MediaDeviceSettings;
};

type RemoteSharingScreenChangeActionType = ReadonlyDeep<{
  type: 'calling/REMOTE_SHARING_SCREEN_CHANGE';
  payload: RemoteSharingScreenChangeType;
}>;

type RemoteVideoChangeActionType = ReadonlyDeep<{
  type: 'calling/REMOTE_VIDEO_CHANGE';
  payload: RemoteVideoChangeType;
}>;

type ReturnToActiveCallActionType = ReadonlyDeep<{
  type: 'calling/RETURN_TO_ACTIVE_CALL';
}>;

type SetLocalAudioActionType = ReadonlyDeep<{
  type: 'calling/SET_LOCAL_AUDIO_FULFILLED';
  payload: SetLocalAudioType;
}>;

type SetLocalVideoFulfilledActionType = ReadonlyDeep<{
  type: 'calling/SET_LOCAL_VIDEO_FULFILLED';
  payload: SetLocalVideoType;
}>;

type SetPresentingFulfilledActionType = ReadonlyDeep<{
  type: 'calling/SET_PRESENTING';
  payload?: PresentedSource;
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
type SetPresentingSourcesActionType = {
  type: 'calling/SET_PRESENTING_SOURCES';
  payload: Array<PresentableSource>;
};

type SetOutgoingRingActionType = ReadonlyDeep<{
  type: 'calling/SET_OUTGOING_RING';
  payload: boolean;
}>;

type StartDirectCallActionType = ReadonlyDeep<{
  type: 'calling/START_DIRECT_CALL';
  payload: StartDirectCallType;
}>;

type ToggleNeedsScreenRecordingPermissionsActionType = ReadonlyDeep<{
  type: 'calling/TOGGLE_NEEDS_SCREEN_RECORDING_PERMISSIONS';
}>;

type ToggleParticipantsActionType = ReadonlyDeep<{
  type: 'calling/TOGGLE_PARTICIPANTS';
}>;

type TogglePipActionType = ReadonlyDeep<{
  type: 'calling/TOGGLE_PIP';
}>;

type ToggleSettingsActionType = ReadonlyDeep<{
  type: 'calling/TOGGLE_SETTINGS';
}>;

type ChangeCallViewActionType = ReadonlyDeep<{
  type: 'calling/CHANGE_CALL_VIEW';
  viewMode: CallViewMode;
}>;

type SwitchToPresentationViewActionType = ReadonlyDeep<{
  type: 'calling/SWITCH_TO_PRESENTATION_VIEW';
}>;

type SwitchFromPresentationViewActionType = ReadonlyDeep<{
  type: 'calling/SWITCH_FROM_PRESENTATION_VIEW';
}>;

// eslint-disable-next-line local-rules/type-alias-readonlydeep
export type CallingActionType =
  | AcceptCallPendingActionType
  | CancelCallActionType
  | CancelIncomingGroupCallRingActionType
  | ChangeCallViewActionType
  | StartCallingLobbyActionType
  | StartCallLinkLobbyActionType
  | CallStateChangeFulfilledActionType
  | ChangeIODeviceFulfilledActionType
  | CloseNeedPermissionScreenActionType
  | ConversationChangedActionType
  | ConversationRemovedActionType
  | DeclineCallActionType
  | GroupCallAudioLevelsChangeActionType
  | GroupCallEndedActionType
  | GroupCallRaisedHandsChangeActionType
  | GroupCallStateChangeActionType
  | GroupCallReactionsReceivedActionType
  | GroupCallReactionsExpiredActionType
  | HangUpActionType
  | IncomingDirectCallActionType
  | IncomingGroupCallActionType
  | OutgoingCallActionType
  | PeekGroupCallFulfilledActionType
  | RefreshIODevicesActionType
  | RemoteSharingScreenChangeActionType
  | RemoteVideoChangeActionType
  | ReturnToActiveCallActionType
  | SendGroupCallReactionActionType
  | SetLocalAudioActionType
  | SetLocalVideoFulfilledActionType
  | SetPresentingSourcesActionType
  | SetOutgoingRingActionType
  | StartDirectCallActionType
  | ToggleNeedsScreenRecordingPermissionsActionType
  | ToggleParticipantsActionType
  | TogglePipActionType
  | SetPresentingFulfilledActionType
  | ToggleSettingsActionType
  | SwitchToPresentationViewActionType
  | SwitchFromPresentationViewActionType;

// Action Creators

function acceptCall(
  payload: AcceptCallType
): ThunkAction<void, RootStateType, unknown, AcceptCallPendingActionType> {
  return async (dispatch, getState) => {
    const { conversationId, asVideoCall } = payload;

    const callingState = getState().calling;
    const call = getOwn(callingState.callsByConversation, conversationId);
    if (!call) {
      log.error('Trying to accept a non-existent call');
      return;
    }

    switch (call.callMode) {
      case CallMode.Direct:
        await calling.acceptDirectCall(conversationId, asVideoCall);
        break;
      case CallMode.Group:
        await calling.joinGroupCall(conversationId, true, asVideoCall, false);
        break;
      case CallMode.Adhoc:
        log.error('Failed to accept adhoc call, this should never happen.');
        break;
      default:
        throw missingCaseError(call);
    }

    dispatch({
      type: ACCEPT_CALL_PENDING,
      payload,
    });
  };
}

function callStateChange(
  payload: CallStateChangeType
): ThunkAction<
  void,
  RootStateType,
  unknown,
  CallStateChangeFulfilledActionType
> {
  return async dispatch => {
    const { callState, acceptedTime, callEndedReason } = payload;

    if (callState === CallState.Ended) {
      ipcRenderer.send('close-screen-share-controller');
    }

    const wasAccepted = acceptedTime != null;
    const isEnded = callState === CallState.Ended && callEndedReason != null;

    const isLocalHangup = callEndedReason === CallEndedReason.LocalHangup;
    const isRemoteHangup = callEndedReason === CallEndedReason.RemoteHangup;

    // Play the hangup noise if:
    if (
      // 1. I hungup (or declined)
      (isEnded && isLocalHangup) ||
      // 2. I answered and then the call ended
      (isEnded && wasAccepted) ||
      // 3. I called and they declined
      (isEnded && !wasAccepted && isRemoteHangup)
    ) {
      await callingTones.playEndCall();
    }

    dispatch({
      type: CALL_STATE_CHANGE_FULFILLED,
      payload,
    });
  };
}

function changeIODevice(
  payload: ChangeIODevicePayloadType
): ThunkAction<
  void,
  RootStateType,
  unknown,
  ChangeIODeviceFulfilledActionType
> {
  return async dispatch => {
    // Only `setPreferredCamera` returns a Promise.
    if (payload.type === CallingDeviceType.CAMERA) {
      await calling.setPreferredCamera(payload.selectedDevice);
    } else if (payload.type === CallingDeviceType.MICROPHONE) {
      calling.setPreferredMicrophone(payload.selectedDevice);
    } else if (payload.type === CallingDeviceType.SPEAKER) {
      calling.setPreferredSpeaker(payload.selectedDevice);
    }
    dispatch({
      type: CHANGE_IO_DEVICE_FULFILLED,
      payload,
    });
  };
}

function closeNeedPermissionScreen(): CloseNeedPermissionScreenActionType {
  return {
    type: CLOSE_NEED_PERMISSION_SCREEN,
    payload: null,
  };
}

function cancelCall(payload: CancelCallType): CancelCallActionType {
  calling.stopCallingLobby(payload.conversationId);

  return {
    type: CANCEL_CALL,
  };
}

function cancelIncomingGroupCallRing(
  payload: CancelIncomingGroupCallRingType
): CancelIncomingGroupCallRingActionType {
  return {
    type: CANCEL_INCOMING_GROUP_CALL_RING,
    payload,
  };
}

function declineCall(
  payload: DeclineCallType
): ThunkAction<
  void,
  RootStateType,
  unknown,
  CancelIncomingGroupCallRingActionType | DeclineCallActionType
> {
  return (dispatch, getState) => {
    const { conversationId } = payload;

    const call = getOwn(getState().calling.callsByConversation, conversationId);
    if (!call) {
      log.error('Trying to decline a non-existent call');
      return;
    }

    switch (call.callMode) {
      case CallMode.Direct:
        calling.declineDirectCall(conversationId);
        dispatch({
          type: DECLINE_DIRECT_CALL,
          payload,
        });
        break;
      case CallMode.Group: {
        const { ringId } = call;
        if (ringId === undefined) {
          log.error('Trying to decline a group call without a ring ID');
        } else {
          calling.declineGroupCall(conversationId, ringId);
          dispatch({
            type: CANCEL_INCOMING_GROUP_CALL_RING,
            payload: { conversationId, ringId },
          });
        }
        break;
      }
      case CallMode.Adhoc:
        log.error(
          'Cannot decline an adhoc call because adhoc calls should never be incoming.'
        );
        break;
      default:
        throw missingCaseError(call);
    }
  };
}

function getPresentingSources(): ThunkAction<
  void,
  RootStateType,
  unknown,
  | SetPresentingSourcesActionType
  | ToggleNeedsScreenRecordingPermissionsActionType
> {
  return async (dispatch, getState) => {
    // We check if the user has permissions first before calling desktopCapturer
    // Next we call getPresentingSources so that one gets the prompt for permissions,
    // if necessary.
    // Finally, we have the if statement which shows the modal, if needed.
    // It is in this exact order so that during first-time-use one will be
    // prompted for permissions and if they so happen to deny we can still
    // capture that state correctly.
    const platform = getPlatform(getState());
    const needsPermission =
      platform === 'darwin' && !hasScreenCapturePermission();

    const sources = await calling.getPresentingSources();

    if (needsPermission) {
      dispatch({
        type: TOGGLE_NEEDS_SCREEN_RECORDING_PERMISSIONS,
      });
      return;
    }

    dispatch({
      type: SET_PRESENTING_SOURCES,
      payload: sources,
    });
  };
}

function groupCallAudioLevelsChange(
  payload: GroupCallAudioLevelsChangeActionPayloadType
): GroupCallAudioLevelsChangeActionType {
  return { type: GROUP_CALL_AUDIO_LEVELS_CHANGE, payload };
}

function groupCallEnded(
  payload: GroupCallEndedActionPayloadType
): ThunkAction<
  void,
  RootStateType,
  unknown,
  GroupCallEndedActionType | ShowErrorModalActionType
> {
  return (dispatch, getState) => {
    const { endedReason } = payload;
    if (endedReason === GroupCallEndReason.DeniedRequestToJoinCall) {
      const i18n = getIntl(getState());
      dispatch({
        type: SHOW_ERROR_MODAL,
        payload: {
          title: i18n('icu:calling__join-request-denied-title'),
          description: i18n('icu:calling__join-request-denied'),
          buttonVariant: ButtonVariant.Primary,
        },
      });
      return;
    }
    if (endedReason === GroupCallEndReason.RemovedFromCall) {
      const i18n = getIntl(getState());
      dispatch({
        type: SHOW_ERROR_MODAL,
        payload: {
          title: i18n('icu:calling__removed-from-call-title'),
          description: i18n('icu:calling__removed-from-call'),
          buttonVariant: ButtonVariant.Primary,
        },
      });
      return;
    }

    dispatch({ type: GROUP_CALL_ENDED, payload });
  };
}

function receiveGroupCallReactions(
  payload: GroupCallReactionsReceivedArgumentType
): ThunkAction<
  void,
  RootStateType,
  unknown,
  GroupCallReactionsReceivedActionType | GroupCallReactionsExpiredActionType
> {
  return async dispatch => {
    const { callMode, conversationId } = payload;
    const timestamp = Date.now();

    dispatch({
      type: GROUP_CALL_REACTIONS_RECEIVED,
      payload: { ...payload, callMode, timestamp },
    });
    await sleep(CALLING_REACTIONS_LIFETIME);

    dispatch({
      type: GROUP_CALL_REACTIONS_EXPIRED,
      payload: { conversationId, timestamp },
    });
  };
}

function groupCallRaisedHandsChange(
  payload: GroupCallRaisedHandsChangeActionPayloadType
): ThunkAction<
  void,
  RootStateType,
  unknown,
  GroupCallRaisedHandsChangeActionType
> {
  return async (dispatch, getState) => {
    const { callMode, conversationId, raisedHands } = payload;

    const existingCall = getGroupCall(
      conversationId,
      getState().calling,
      callMode
    );
    const isFirstHandRaised =
      existingCall &&
      !existingCall.raisedHands?.length &&
      raisedHands.length > 0;
    if (isFirstHandRaised) {
      drop(callingTones.handRaised());
    }

    dispatch({ type: GROUP_CALL_RAISED_HANDS_CHANGE, payload });
  };
}

function groupCallStateChange(
  payload: GroupCallStateChangeArgumentType
): ThunkAction<void, RootStateType, unknown, GroupCallStateChangeActionType> {
  return async (dispatch, getState) => {
    let didSomeoneStartPresenting: boolean;
    const activeCall = getActiveCall(getState().calling);
    if (isGroupOrAdhocCallState(activeCall)) {
      const wasSomeonePresenting = activeCall.remoteParticipants.some(
        participant => participant.presenting
      );
      const isSomeonePresenting = payload.remoteParticipants.some(
        participant => participant.presenting
      );
      didSomeoneStartPresenting = !wasSomeonePresenting && isSomeonePresenting;
    } else {
      didSomeoneStartPresenting = false;
    }

    const { ourAci } = getState().user;
    strictAssert(ourAci, 'groupCallStateChange failed to fetch our ACI');

    dispatch({
      type: GROUP_CALL_STATE_CHANGE,
      payload: {
        ...payload,
        ourAci,
      },
    });

    if (didSomeoneStartPresenting) {
      void callingTones.someonePresenting();
    }

    if (payload.connectionState === GroupCallConnectionState.NotConnected) {
      ipcRenderer.send('close-screen-share-controller');
    }
  };
}

function hangUpActiveCall(
  reason: string
): ThunkAction<void, RootStateType, unknown, HangUpActionType> {
  return async (dispatch, getState) => {
    const state = getState();

    const activeCall = getActiveCall(state.calling);
    if (!activeCall) {
      return;
    }

    const { conversationId } = activeCall;

    calling.hangup(conversationId, reason);

    dispatch({
      type: HANG_UP,
      payload: {
        conversationId,
      },
    });

    if (isGroupOrAdhocCallState(activeCall)) {
      // We want to give the group call time to disconnect.
      await sleep(1000);
      doGroupCallPeek({
        conversationId,
        callMode: activeCall.callMode,
        dispatch,
        getState,
      });
    }
  };
}

function sendGroupCallRaiseHand(
  payload: SendGroupCallRaiseHandType
): ThunkAction<void, RootStateType, unknown, SendGroupCallRaiseHandActionType> {
  return dispatch => {
    calling.sendGroupCallRaiseHand(payload.conversationId, payload.raise);

    dispatch({
      type: RAISE_HAND_GROUP_CALL,
      payload,
    });
  };
}

function sendGroupCallReaction(
  payload: SendGroupCallReactionType
): ThunkAction<
  void,
  RootStateType,
  unknown,
  SendGroupCallReactionActionType | GroupCallReactionsExpiredActionType
> {
  return async dispatch => {
    const { callMode, conversationId } = payload;
    const timestamp = Date.now();

    calling.sendGroupCallReaction(payload.conversationId, payload.value);
    dispatch({
      type: SEND_GROUP_CALL_REACTION,
      payload: { ...payload, callMode, timestamp },
    });
    await sleep(CALLING_REACTIONS_LIFETIME);

    dispatch({
      type: GROUP_CALL_REACTIONS_EXPIRED,
      payload: { conversationId, timestamp },
    });
  };
}

function receiveIncomingDirectCall(
  payload: IncomingDirectCallType
): ThunkAction<void, RootStateType, unknown, IncomingDirectCallActionType> {
  return (dispatch, getState) => {
    const callState = getState().calling;

    if (
      callState.activeCallState &&
      callState.activeCallState.conversationId === payload.conversationId
    ) {
      calling.stopCallingLobby();
    }

    dispatch({
      type: INCOMING_DIRECT_CALL,
      payload,
    });
  };
}

function receiveIncomingGroupCall(
  payload: IncomingGroupCallType
): IncomingGroupCallActionType {
  return {
    type: INCOMING_GROUP_CALL,
    payload,
  };
}

function openSystemPreferencesAction(): ThunkAction<
  void,
  RootStateType,
  unknown,
  never
> {
  return () => {
    void openSystemPreferences();
  };
}

function outgoingCall(payload: StartDirectCallType): OutgoingCallActionType {
  return {
    type: OUTGOING_CALL,
    payload,
  };
}

function peekGroupCallForTheFirstTime(
  conversationId: string
): ThunkAction<void, RootStateType, unknown, PeekGroupCallFulfilledActionType> {
  return (dispatch, getState) => {
    const call = getOwn(getState().calling.callsByConversation, conversationId);
    const shouldPeek =
      !call || (isGroupOrAdhocCallState(call) && !call.peekInfo);
    const callMode = call?.callMode ?? CallMode.Group;
    if (callMode === CallMode.Direct) {
      return;
    }

    if (shouldPeek) {
      doGroupCallPeek({
        conversationId,
        callMode,
        dispatch,
        getState,
      });
    }
  };
}

function peekGroupCallIfItHasMembers(
  conversationId: string
): ThunkAction<void, RootStateType, unknown, PeekGroupCallFulfilledActionType> {
  return (dispatch, getState) => {
    const call = getOwn(getState().calling.callsByConversation, conversationId);
    const shouldPeek =
      call &&
      isGroupOrAdhocCallState(call) &&
      call.joinState === GroupCallJoinState.NotJoined &&
      call.peekInfo &&
      call.peekInfo.deviceCount > 0;
    if (shouldPeek) {
      doGroupCallPeek({
        conversationId,
        callMode: call.callMode,
        dispatch,
        getState,
      });
    }
  };
}

function peekNotConnectedGroupCall(
  payload: PeekNotConnectedGroupCallType
): ThunkAction<void, RootStateType, unknown, PeekGroupCallFulfilledActionType> {
  return (dispatch, getState) => {
    const { conversationId } = payload;
    doGroupCallPeek({
      conversationId,
      callMode: CallMode.Group,
      dispatch,
      getState,
    });
  };
}

function refreshIODevices(
  payload: MediaDeviceSettings
): RefreshIODevicesActionType {
  return {
    type: REFRESH_IO_DEVICES,
    payload,
  };
}

function remoteSharingScreenChange(
  payload: RemoteSharingScreenChangeType
): RemoteSharingScreenChangeActionType {
  return {
    type: REMOTE_SHARING_SCREEN_CHANGE,
    payload,
  };
}

function remoteVideoChange(
  payload: RemoteVideoChangeType
): RemoteVideoChangeActionType {
  return {
    type: REMOTE_VIDEO_CHANGE,
    payload,
  };
}

function returnToActiveCall(): ReturnToActiveCallActionType {
  return {
    type: RETURN_TO_ACTIVE_CALL,
  };
}

function setIsCallActive(
  isCallActive: boolean
): ThunkAction<void, RootStateType, unknown, never> {
  return () => {
    window.SignalContext.setIsCallActive(isCallActive);
  };
}

function setLocalPreview(
  payload: SetLocalPreviewType
): ThunkAction<void, RootStateType, unknown, never> {
  return () => {
    calling.videoCapturer.setLocalPreview(payload.element);
  };
}

function setRendererCanvas(
  payload: SetRendererCanvasType
): ThunkAction<void, RootStateType, unknown, never> {
  return () => {
    calling.videoRenderer.setCanvas(payload.element);
  };
}

function setLocalAudio(
  payload: SetLocalAudioType
): ThunkAction<void, RootStateType, unknown, SetLocalAudioActionType> {
  return (dispatch, getState) => {
    const activeCall = getActiveCall(getState().calling);
    if (!activeCall) {
      log.warn('Trying to set local audio when no call is active');
      return;
    }

    calling.setOutgoingAudio(activeCall.conversationId, payload.enabled);

    dispatch({
      type: SET_LOCAL_AUDIO_FULFILLED,
      payload,
    });
  };
}

function setLocalVideo(
  payload: SetLocalVideoType
): ThunkAction<void, RootStateType, unknown, SetLocalVideoFulfilledActionType> {
  return async (dispatch, getState) => {
    const activeCall = getActiveCall(getState().calling);
    if (!activeCall) {
      log.warn('Trying to set local video when no call is active');
      return;
    }

    let enabled: boolean;
    if (await requestCameraPermissions()) {
      if (
        isGroupOrAdhocCallState(activeCall) ||
        (activeCall.callMode === CallMode.Direct && activeCall.callState)
      ) {
        calling.setOutgoingVideo(activeCall.conversationId, payload.enabled);
      } else if (payload.enabled) {
        calling.enableLocalCamera();
      } else {
        calling.disableLocalVideo();
      }
      ({ enabled } = payload);
    } else {
      enabled = false;
    }

    dispatch({
      type: SET_LOCAL_VIDEO_FULFILLED,
      payload: {
        ...payload,
        enabled,
      },
    });
  };
}

function setGroupCallVideoRequest(
  payload: SetGroupCallVideoRequestType
): ThunkAction<void, RootStateType, unknown, never> {
  return () => {
    calling.setGroupCallVideoRequest(
      payload.conversationId,
      payload.resolutions.map(resolution => ({
        ...resolution,
        // The `framerate` property in RingRTC has to be set, even if it's set to
        //   `undefined`.
        framerate: undefined,
      })),
      payload.speakerHeight
    );
  };
}

function setPresenting(
  sourceToPresent?: PresentedSource
): ThunkAction<void, RootStateType, unknown, SetPresentingFulfilledActionType> {
  return async (dispatch, getState) => {
    const callingState = getState().calling;
    const { activeCallState } = callingState;
    const activeCall = getActiveCall(callingState);
    if (!activeCall || !activeCallState) {
      log.warn('Trying to present when no call is active');
      return;
    }

    await calling.setPresenting(
      activeCall.conversationId,
      activeCallState.hasLocalVideo,
      sourceToPresent
    );

    dispatch({
      type: SET_PRESENTING,
      payload: sourceToPresent,
    });

    if (sourceToPresent) {
      await callingTones.someonePresenting();
    }
  };
}

function setOutgoingRing(payload: boolean): SetOutgoingRingActionType {
  return {
    type: SET_OUTGOING_RING,
    payload,
  };
}

function onOutgoingVideoCallInConversation(
  conversationId: string
): ThunkAction<
  void,
  RootStateType,
  unknown,
  StartCallingLobbyActionType | ShowToastActionType
> {
  return async (dispatch, getState) => {
    const conversation = window.ConversationController.get(conversationId);
    if (!conversation) {
      throw new Error(
        `onOutgoingVideoCallInConversation: No conversation found for conversation ${conversationId}`
      );
    }

    log.info('onOutgoingVideoCallInConversation: about to start a video call');

    const call = getOwn(getState().calling.callsByConversation, conversationId);

    // Technically not necessary, but isAnybodyElseInGroupCall requires it
    const ourAci = window.storage.user.getCheckedAci();
    const isOngoingGroupCall =
      call &&
      ourAci &&
      isGroupOrAdhocCallState(call) &&
      call.peekInfo &&
      isAnybodyElseInGroupCall(call.peekInfo, ourAci);

    // If it's a group call on an announcementsOnly group, only allow join if the call
    //   has already been started (presumably by the admin)
    if (conversation.get('announcementsOnly') && !conversation.areWeAdmin()) {
      if (!isOngoingGroupCall) {
        dispatch({
          type: SHOW_TOAST,
          payload: {
            toastType: ToastType.CannotStartGroupCall,
          },
        });
        return;
      }
    }

    const source = isOngoingGroupCall
      ? SafetyNumberChangeSource.JoinCall
      : SafetyNumberChangeSource.InitiateCall;

    if (await isCallSafe(conversation.attributes, source)) {
      log.info(
        'onOutgoingVideoCallInConversation: call is deemed "safe". Making call'
      );
      dispatch(
        startCallingLobby({
          conversationId,
          isVideoCall: true,
        })
      );
      log.info('onOutgoingVideoCallInConversation: started the call');
    } else {
      log.info(
        'onOutgoingVideoCallInConversation: call is deemed "unsafe". Stopping'
      );
    }
  };
}

function onOutgoingAudioCallInConversation(
  conversationId: string
): ThunkAction<void, RootStateType, unknown, StartCallingLobbyActionType> {
  return async (dispatch, getState) => {
    const conversation = window.ConversationController.get(conversationId);
    if (!conversation) {
      throw new Error(
        `onOutgoingAudioCallInConversation: No conversation found for conversation ${conversationId}`
      );
    }

    if (!isDirectConversation(conversation.attributes)) {
      throw new Error(
        `onOutgoingAudioCallInConversation: Conversation ${conversation.idForLogging()} is not 1:1`
      );
    }
    // Because audio calls are currently restricted to 1:1 conversations, this will always
    //   be a new call we are initiating.
    const source = SafetyNumberChangeSource.InitiateCall;

    log.info('onOutgoingAudioCallInConversation: about to start an audio call');

    if (await isCallSafe(conversation.attributes, source)) {
      log.info(
        'onOutgoingAudioCallInConversation: call is deemed "safe". Making call'
      );
      startCallingLobby({
        conversationId,
        isVideoCall: false,
      })(dispatch, getState, undefined);
      log.info('onOutgoingAudioCallInConversation: started the call');
    } else {
      log.info(
        'onOutgoingAudioCallInConversation: call is deemed "unsafe". Stopping'
      );
    }
  };
}

function startCallLinkLobbyByRoomId(
  roomId: string
): StartCallLinkLobbyThunkActionType {
  return async (dispatch, getState) => {
    const state = getState();
    const callLink = getOwn(state.calling.callLinks, roomId);

    strictAssert(
      callLink,
      `startCallLinkLobbyByRoomId(${roomId}): call link not found`
    );

    const { rootKey } = callLink;
    await _startCallLinkLobby({ rootKey, dispatch, getState });
  };
}

function startCallLinkLobby({
  rootKey,
}: StartCallLinkLobbyType): StartCallLinkLobbyThunkActionType {
  return async (dispatch, getState) => {
    await _startCallLinkLobby({ rootKey, dispatch, getState });
  };
}

const _startCallLinkLobby = async ({
  rootKey,
  dispatch,
  getState,
}: {
  rootKey: string;
  dispatch: ThunkDispatch<
    RootStateType,
    unknown,
    StartCallLinkLobbyActionType | ShowErrorModalActionType
  >;
  getState: () => RootStateType;
}) => {
  const state = getState();

  if (state.calling.activeCallState) {
    const i18n = getIntl(getState());
    dispatch({
      type: SHOW_ERROR_MODAL,
      payload: {
        title: i18n('icu:calling__cant-join'),
        description: i18n('icu:calling__dialog-already-in-call'),
        buttonVariant: ButtonVariant.Primary,
      },
    });
    return;
  }

  const callLinkRootKey = CallLinkRootKey.parse(rootKey);

  const callLinkState = await calling.readCallLink({ callLinkRootKey });
  if (!callLinkState) {
    const i18n = getIntl(getState());
    dispatch({
      type: SHOW_ERROR_MODAL,
      payload: {
        title: i18n('icu:calling__cant-join'),
        description: i18n('icu:calling__call-link-connection-issues'),
        buttonVariant: ButtonVariant.Primary,
      },
    });
    return;
  }
  if (callLinkState.revoked || callLinkState.expiration < new Date()) {
    const i18n = getIntl(getState());
    dispatch({
      type: SHOW_ERROR_MODAL,
      payload: {
        title: i18n('icu:calling__cant-join'),
        description: i18n('icu:calling__call-link-no-longer-valid'),
        buttonVariant: ButtonVariant.Primary,
      },
    });
    return;
  }

  const roomId = getRoomIdFromRootKey(callLinkRootKey);
  const formattedCallLinkState =
    calling.formatCallLinkStateForRedux(callLinkState);
  try {
    const { name, restrictions, expiration, revoked } = formattedCallLinkState;
    const callLinkExists = await dataInterface.callLinkExists(roomId);
    if (callLinkExists) {
      await dataInterface.updateCallLinkState(
        roomId,
        name,
        restrictions,
        expiration,
        revoked
      );
      log.info('startCallLinkLobby: Updated existing call link', roomId);
    } else {
      await dataInterface.insertCallLink({
        roomId,
        rootKey,
        adminKey: null,
        name,
        restrictions,
        revoked,
        expiration,
      });
      log.info('startCallLinkLobby: Saved new call link', roomId);
    }
  } catch (err) {
    log.error(
      'startCallLinkLobby: Call link DB error',
      Errors.toLogFormat(err)
    );
  }

  const groupCall = getGroupCall(roomId, state.calling, CallMode.Adhoc);
  const groupCallDeviceCount =
    groupCall?.peekInfo?.deviceCount ||
    groupCall?.remoteParticipants.length ||
    0;

  const callLobbyData = await calling.startCallLinkLobby({
    callLinkRootKey,
    hasLocalAudio: groupCallDeviceCount < 8,
  });
  if (!callLobbyData) {
    return;
  }

  dispatch({
    type: START_CALL_LINK_LOBBY,
    payload: {
      ...callLobbyData,
      callLinkState: formattedCallLinkState,
      callLinkRootKey: rootKey,
      conversationId: roomId,
      isConversationTooBigToRing: false,
    },
  });
};

function startCallingLobby({
  conversationId,
  isVideoCall,
}: StartCallingLobbyType): ThunkAction<
  void,
  RootStateType,
  unknown,
  StartCallingLobbyActionType
> {
  return async (dispatch, getState) => {
    const state = getState();
    const conversation = getOwn(
      state.conversations.conversationLookup,
      conversationId
    );
    strictAssert(
      conversation,
      "startCallingLobby: can't start lobby without a conversation"
    );

    strictAssert(
      !state.calling.activeCallState,
      "startCallingLobby: can't start lobby if a call is active"
    );

    // The group call device count is considered 0 for a direct call.
    const groupCall = getGroupCall(
      conversationId,
      state.calling,
      CallMode.Group
    );
    const groupCallDeviceCount =
      groupCall?.peekInfo?.deviceCount ||
      groupCall?.remoteParticipants.length ||
      0;

    const callLobbyData = await calling.startCallingLobby({
      conversation,
      hasLocalAudio: groupCallDeviceCount < 8,
      hasLocalVideo: isVideoCall,
    });
    if (!callLobbyData) {
      return;
    }

    dispatch({
      type: START_CALLING_LOBBY,
      payload: {
        ...callLobbyData,
        conversationId,
        isConversationTooBigToRing: isConversationTooBigToRing(conversation),
      },
    });
  };
}

function startCall(
  payload: StartCallType
): ThunkAction<void, RootStateType, unknown, StartDirectCallActionType> {
  return async (dispatch, getState) => {
    const { conversationId, hasLocalAudio, hasLocalVideo } = payload;
    switch (payload.callMode) {
      case CallMode.Direct:
        await calling.startOutgoingDirectCall(
          conversationId,
          hasLocalAudio,
          hasLocalVideo
        );
        dispatch({
          type: START_DIRECT_CALL,
          payload,
        });
        break;
      case CallMode.Group: {
        let outgoingRing: boolean;

        const state = getState();
        const { activeCallState } = state.calling;
        if (activeCallState?.outgoingRing) {
          const conversation = getOwn(
            state.conversations.conversationLookup,
            activeCallState.conversationId
          );
          outgoingRing = Boolean(
            conversation && !isConversationTooBigToRing(conversation)
          );
        } else {
          outgoingRing = false;
        }

        await calling.joinGroupCall(
          conversationId,
          hasLocalAudio,
          hasLocalVideo,
          outgoingRing
        );
        // The calling service should already be wired up to Redux so we don't need to
        //   dispatch anything here.
        break;
      }
      case CallMode.Adhoc: {
        const state = getState();

        const callLink = getOwn(state.calling.callLinks, conversationId);
        if (!callLink) {
          log.error(
            `startCall: Failed to start call link call because roomId ${conversationId} is missing from calling state`
          );
          return;
        }

        await calling.joinCallLinkCall({
          roomId: conversationId,
          rootKey: callLink.rootKey,
          hasLocalAudio,
          hasLocalVideo,
        });

        // The calling service should already be wired up to Redux so we don't need to
        //   dispatch anything here.
        break;
      }
      default:
        throw missingCaseError(payload.callMode);
    }
  };
}

function toggleParticipants(): ToggleParticipantsActionType {
  return {
    type: TOGGLE_PARTICIPANTS,
  };
}

function togglePip(): TogglePipActionType {
  return {
    type: TOGGLE_PIP,
  };
}

function toggleScreenRecordingPermissionsDialog(): ToggleNeedsScreenRecordingPermissionsActionType {
  return {
    type: TOGGLE_NEEDS_SCREEN_RECORDING_PERMISSIONS,
  };
}

function toggleSettings(): ToggleSettingsActionType {
  return {
    type: TOGGLE_SETTINGS,
  };
}

function changeCallView(mode: CallViewMode): ChangeCallViewActionType {
  return {
    type: CHANGE_CALL_VIEW,
    viewMode: mode,
  };
}

function switchToPresentationView(): SwitchToPresentationViewActionType {
  return {
    type: SWITCH_TO_PRESENTATION_VIEW,
  };
}

function switchFromPresentationView(): SwitchFromPresentationViewActionType {
  return {
    type: SWITCH_FROM_PRESENTATION_VIEW,
  };
}
export const actions = {
  acceptCall,
  callStateChange,
  cancelCall,
  cancelIncomingGroupCallRing,
  changeCallView,
  changeIODevice,
  closeNeedPermissionScreen,
  declineCall,
  getPresentingSources,
  groupCallAudioLevelsChange,
  groupCallEnded,
  groupCallRaisedHandsChange,
  groupCallStateChange,
  hangUpActiveCall,
  onOutgoingVideoCallInConversation,
  onOutgoingAudioCallInConversation,
  openSystemPreferencesAction,
  outgoingCall,
  peekGroupCallForTheFirstTime,
  peekGroupCallIfItHasMembers,
  peekNotConnectedGroupCall,
  receiveGroupCallReactions,
  receiveIncomingDirectCall,
  receiveIncomingGroupCall,
  refreshIODevices,
  remoteSharingScreenChange,
  remoteVideoChange,
  returnToActiveCall,
  sendGroupCallRaiseHand,
  sendGroupCallReaction,
  setGroupCallVideoRequest,
  setIsCallActive,
  setLocalAudio,
  setLocalPreview,
  setLocalVideo,
  setOutgoingRing,
  setPresenting,
  setRendererCanvas,
  startCall,
  startCallLinkLobby,
  startCallLinkLobbyByRoomId,
  startCallingLobby,
  switchToPresentationView,
  switchFromPresentationView,
  toggleParticipants,
  togglePip,
  toggleScreenRecordingPermissionsDialog,
  toggleSettings,
};

export const useCallingActions = (): BoundActionCreatorsMapObject<
  typeof actions
> => useBoundActions(actions);

export type ActionsType = ReadonlyDeep<typeof actions>;

// Reducer

export function getEmptyState(): CallingStateType {
  return {
    availableCameras: [],
    availableMicrophones: [],
    availableSpeakers: [],
    selectedCamera: undefined,
    selectedMicrophone: undefined,
    selectedSpeaker: undefined,

    callsByConversation: {},
    adhocCalls: {},
    activeCallState: undefined,
    callLinks: {},
  };
}

function getGroupCall(
  conversationId: string,
  state: Readonly<CallingStateType>,
  callMode: CallMode
): undefined | GroupCallStateType {
  const call =
    callMode === CallMode.Adhoc
      ? getOwn(state.adhocCalls, conversationId)
      : getOwn(state.callsByConversation, conversationId);
  return isGroupOrAdhocCallState(call) ? call : undefined;
}

function removeConversationFromState(
  state: Readonly<CallingStateType>,
  conversationId: string
): CallingStateType {
  return {
    ...(conversationId === state.activeCallState?.conversationId
      ? omit(state, 'activeCallState')
      : state),
    callsByConversation: omit(state.callsByConversation, conversationId),
    adhocCalls: omit(state.adhocCalls, conversationId),
  };
}

function mergeCallWithGroupCallLookups({
  state,
  callMode,
  conversationId,
  call,
}: {
  state: Readonly<CallingStateType>;
  callMode: CallMode;
  conversationId: string;
  call: GroupCallStateType;
}): {
  callsByConversation: CallsByConversationType;
  adhocCalls: AdhocCallsType;
} {
  const { callsByConversation, adhocCalls } = state;
  const isAdhocCall = callMode === CallMode.Adhoc;

  return {
    callsByConversation: isAdhocCall
      ? callsByConversation
      : {
          ...callsByConversation,
          [conversationId]: call,
        },
    adhocCalls: isAdhocCall
      ? {
          ...adhocCalls,
          [conversationId]: call,
        }
      : adhocCalls,
  };
}

export function reducer(
  state: Readonly<CallingStateType> = getEmptyState(),
  action: Readonly<CallingActionType>
): CallingStateType {
  const { callsByConversation, adhocCalls } = state;

  if (
    action.type === START_CALLING_LOBBY ||
    action.type === START_CALL_LINK_LOBBY
  ) {
    const { callMode, conversationId } = action.payload;

    let call: DirectCallStateType | GroupCallStateType;
    let newAdhocCalls: AdhocCallsType;
    let outgoingRing: boolean;
    switch (callMode) {
      case CallMode.Direct:
        call = {
          callMode: CallMode.Direct,
          conversationId,
          isIncoming: false,
          isVideoCall: action.payload.hasLocalVideo,
        };
        outgoingRing = true;
        newAdhocCalls = adhocCalls;
        break;
      case CallMode.Group:
      case CallMode.Adhoc: {
        const { connectionState, joinState, peekInfo, remoteParticipants } =
          action.payload;
        // We expect to be in this state briefly. The Calling service should update the
        //   call state shortly.
        const existingCall = getGroupCall(conversationId, state, callMode);
        const ringState = getGroupCallRingState(existingCall);
        call = {
          callMode,
          conversationId,
          connectionState,
          joinState,
          localDemuxId: undefined,
          peekInfo: peekInfo ||
            existingCall?.peekInfo || {
              acis: remoteParticipants.map(({ aci }) => aci),
              maxDevices: Infinity,
              deviceCount: remoteParticipants.length,
            },
          remoteParticipants,
          ...ringState,
        };

        if (callMode === CallMode.Group) {
          outgoingRing =
            !ringState.ringId &&
            !call.peekInfo?.acis.length &&
            !call.remoteParticipants.length &&
            !action.payload.isConversationTooBigToRing;
          newAdhocCalls = adhocCalls;
        } else if (callMode === CallMode.Adhoc) {
          outgoingRing = false;
          newAdhocCalls = {
            ...adhocCalls,
            [conversationId]: call,
          };
        } else {
          throw missingCaseError(action.payload);
        }
        break;
      }
      default:
        throw missingCaseError(action.payload);
    }

    const { callLinks } = state;

    const newCallsByConversation =
      callMode === CallMode.Adhoc
        ? callsByConversation
        : {
            ...callsByConversation,
            [conversationId]: call,
          };

    return {
      ...state,
      callsByConversation: newCallsByConversation,
      adhocCalls: newAdhocCalls,
      callLinks:
        action.type === START_CALL_LINK_LOBBY
          ? {
              ...callLinks,
              [conversationId]: {
                ...action.payload.callLinkState,
                rootKey: action.payload.callLinkRootKey,
                adminKey: null,
              },
            }
          : callLinks,
      activeCallState: {
        callMode,
        conversationId,
        hasLocalAudio: action.payload.hasLocalAudio,
        hasLocalVideo: action.payload.hasLocalVideo,
        localAudioLevel: 0,
        viewMode: CallViewMode.Paginated,
        pip: false,
        settingsDialogOpen: false,
        showParticipantsList: false,
        outgoingRing,
        joinedAt: null,
      },
    };
  }

  if (action.type === START_DIRECT_CALL) {
    return {
      ...state,
      callsByConversation: {
        ...callsByConversation,
        [action.payload.conversationId]: {
          callMode: CallMode.Direct,
          conversationId: action.payload.conversationId,
          callState: CallState.Prering,
          isIncoming: false,
          isVideoCall: action.payload.hasLocalVideo,
        },
      },
      activeCallState: {
        callMode: CallMode.Direct,
        conversationId: action.payload.conversationId,
        hasLocalAudio: action.payload.hasLocalAudio,
        hasLocalVideo: action.payload.hasLocalVideo,
        localAudioLevel: 0,
        viewMode: CallViewMode.Paginated,
        pip: false,
        settingsDialogOpen: false,
        showParticipantsList: false,
        outgoingRing: true,
        joinedAt: null,
      },
    };
  }

  if (action.type === ACCEPT_CALL_PENDING) {
    const call = getOwn(
      state.callsByConversation,
      action.payload.conversationId
    );
    if (!call) {
      log.warn('Unable to accept a non-existent call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        callMode: call.callMode,
        conversationId: action.payload.conversationId,
        hasLocalAudio: true,
        hasLocalVideo: action.payload.asVideoCall,
        localAudioLevel: 0,
        viewMode: CallViewMode.Paginated,
        pip: false,
        settingsDialogOpen: false,
        showParticipantsList: false,
        outgoingRing: false,
        joinedAt: null,
      },
    };
  }

  if (
    action.type === CANCEL_CALL ||
    action.type === HANG_UP ||
    action.type === CLOSE_NEED_PERMISSION_SCREEN
  ) {
    const activeCall = getActiveCall(state);
    if (!activeCall) {
      log.warn('No active call to remove');
      return state;
    }
    switch (activeCall.callMode) {
      case CallMode.Direct:
        return removeConversationFromState(state, activeCall.conversationId);
      case CallMode.Group:
      case CallMode.Adhoc:
        return omit(state, 'activeCallState');
      default:
        throw missingCaseError(activeCall);
    }
  }

  if (action.type === CANCEL_INCOMING_GROUP_CALL_RING) {
    const { conversationId, ringId } = action.payload;

    const groupCall = getGroupCall(conversationId, state, CallMode.Group);
    if (!groupCall || groupCall.ringId !== ringId) {
      return state;
    }

    return {
      ...state,
      callsByConversation: {
        ...callsByConversation,
        [conversationId]: omit(groupCall, ['ringId', 'ringerAci']),
      },
    };
  }

  if (action.type === 'CONVERSATION_CHANGED') {
    const activeCall = getActiveCall(state);
    const { activeCallState } = state;
    if (
      !activeCallState?.outgoingRing ||
      activeCallState.conversationId !== action.payload.id ||
      !isGroupOrAdhocCallState(activeCall) ||
      activeCall.joinState !== GroupCallJoinState.NotJoined ||
      !isConversationTooBigToRing(action.payload.data)
    ) {
      return state;
    }

    return {
      ...state,
      activeCallState: { ...activeCallState, outgoingRing: false },
    };
  }

  if (action.type === 'CONVERSATION_REMOVED') {
    return removeConversationFromState(state, action.payload.id);
  }

  if (action.type === DECLINE_DIRECT_CALL) {
    return removeConversationFromState(state, action.payload.conversationId);
  }

  if (action.type === INCOMING_DIRECT_CALL) {
    return {
      ...state,
      callsByConversation: {
        ...callsByConversation,
        [action.payload.conversationId]: {
          callMode: CallMode.Direct,
          conversationId: action.payload.conversationId,
          callState: CallState.Prering,
          isIncoming: true,
          isVideoCall: action.payload.isVideoCall,
        },
      },
    };
  }

  if (action.type === INCOMING_GROUP_CALL) {
    const { conversationId, ringId, ringerAci } = action.payload;

    let groupCall: GroupCallStateType;
    const existingGroupCall = getGroupCall(
      conversationId,
      state,
      CallMode.Group
    );
    if (existingGroupCall) {
      if (existingGroupCall.ringerAci) {
        log.info('Group call was already ringing');
        return state;
      }
      if (existingGroupCall.joinState !== GroupCallJoinState.NotJoined) {
        log.info("Got a ring for a call we're already in");
        return state;
      }

      groupCall = {
        ...existingGroupCall,
        ringId,
        ringerAci,
      };
    } else {
      groupCall = {
        callMode: CallMode.Group,
        conversationId,
        connectionState: GroupCallConnectionState.NotConnected,
        joinState: GroupCallJoinState.NotJoined,
        localDemuxId: undefined,
        peekInfo: {
          acis: [],
          maxDevices: Infinity,
          deviceCount: 0,
        },
        remoteParticipants: [],
        ringId,
        ringerAci,
      };
    }

    return {
      ...state,
      callsByConversation: {
        ...callsByConversation,
        [conversationId]: groupCall,
      },
    };
  }

  if (action.type === OUTGOING_CALL) {
    return {
      ...state,
      callsByConversation: {
        ...callsByConversation,
        [action.payload.conversationId]: {
          callMode: CallMode.Direct,
          conversationId: action.payload.conversationId,
          callState: CallState.Prering,
          isIncoming: false,
          isVideoCall: action.payload.hasLocalVideo,
        },
      },
      activeCallState: {
        callMode: CallMode.Direct,
        conversationId: action.payload.conversationId,
        hasLocalAudio: action.payload.hasLocalAudio,
        hasLocalVideo: action.payload.hasLocalVideo,
        localAudioLevel: 0,
        viewMode: CallViewMode.Paginated,
        pip: false,
        settingsDialogOpen: false,
        showParticipantsList: false,
        outgoingRing: true,
        joinedAt: null,
      },
    };
  }

  if (action.type === CALL_STATE_CHANGE_FULFILLED) {
    // We want to keep the state around for ended calls if they resulted in a message
    //   request so we can show the "needs permission" screen.
    if (
      action.payload.callState === CallState.Ended &&
      action.payload.callEndedReason !==
        CallEndedReason.RemoteHangupNeedPermission
    ) {
      return removeConversationFromState(state, action.payload.conversationId);
    }

    const call = getOwn(
      state.callsByConversation,
      action.payload.conversationId
    );
    if (call?.callMode !== CallMode.Direct) {
      log.warn('Cannot update state for a non-direct call');
      return state;
    }

    let activeCallState: undefined | ActiveCallStateType;
    if (
      state.activeCallState?.conversationId === action.payload.conversationId
    ) {
      activeCallState = {
        ...state.activeCallState,
        joinedAt: action.payload.acceptedTime ?? null,
      };
    } else {
      ({ activeCallState } = state);
    }

    return {
      ...state,
      callsByConversation: {
        ...callsByConversation,
        [action.payload.conversationId]: {
          ...call,
          callState: action.payload.callState,
          callEndedReason: action.payload.callEndedReason,
        },
      },
      activeCallState,
    };
  }

  if (action.type === GROUP_CALL_AUDIO_LEVELS_CHANGE) {
    const { callMode, conversationId, remoteDeviceStates } = action.payload;

    const { activeCallState } = state;
    const existingCall = getGroupCall(conversationId, state, callMode);

    // The PiP check is an optimization. We don't need to update audio levels if the user
    //   cannot see them.
    if (!activeCallState || activeCallState.pip || !existingCall) {
      return state;
    }

    const localAudioLevel = truncateAudioLevel(action.payload.localAudioLevel);

    const remoteAudioLevels = new Map<number, number>();
    remoteDeviceStates.forEach(({ audioLevel, demuxId }) => {
      // We expect `audioLevel` to be a number but have this check just in case.
      if (typeof audioLevel !== 'number') {
        return;
      }

      const graded = truncateAudioLevel(audioLevel);
      if (graded > 0) {
        remoteAudioLevels.set(demuxId, graded);
      }
    });

    // This action is dispatched frequently. This equality check helps avoid re-renders.
    const oldLocalAudioLevel = activeCallState.localAudioLevel;
    const oldRemoteAudioLevels = existingCall.remoteAudioLevels;
    if (
      oldLocalAudioLevel === localAudioLevel &&
      oldRemoteAudioLevels &&
      mapUtil.isEqual(oldRemoteAudioLevels, remoteAudioLevels)
    ) {
      return state;
    }

    return {
      ...state,
      activeCallState: { ...activeCallState, localAudioLevel },
      ...mergeCallWithGroupCallLookups({
        state,
        callMode: existingCall.callMode,
        conversationId,
        call: { ...existingCall, remoteAudioLevels },
      }),
    };
  }

  if (action.type === GROUP_CALL_STATE_CHANGE) {
    const {
      callMode,
      connectionState,
      conversationId,
      hasLocalAudio,
      hasLocalVideo,
      localDemuxId,
      joinState,
      ourAci,
      peekInfo,
      remoteParticipants,
    } = action.payload;

    const existingCall = getGroupCall(conversationId, state, callMode);
    const existingRingState = getGroupCallRingState(existingCall);

    // Generare a better log line that would help piece together ACIs and
    // demuxIds.
    const currentlyInCall = new Map(
      existingCall?.remoteParticipants.map(({ demuxId, aci }) => [
        demuxId,
        aci,
      ]) ?? []
    );
    const nextInCall = new Map(
      remoteParticipants.map(({ demuxId, aci }) => [demuxId, aci]) ?? []
    );

    const membersLeft = new Array<`${AciString}:${number}`>();
    for (const [demuxId, aci] of currentlyInCall) {
      if (!nextInCall.has(demuxId)) {
        membersLeft.push(`${aci}:${demuxId}`);
      }
    }

    const membersJoined = new Array<`${AciString}:${number}`>();
    for (const [demuxId, aci] of nextInCall) {
      if (!currentlyInCall.has(demuxId)) {
        membersJoined.push(`${aci}:${demuxId}`);
      }
    }

    log.info(
      'groupCallStateChange:',
      conversationId,
      GroupCallConnectionState[connectionState],
      GroupCallJoinState[joinState],
      `joined={${membersJoined.join(', ')}}`,
      `left={${membersLeft.join(', ')}}`
    );

    const newPeekInfo = peekInfo ||
      existingCall?.peekInfo || {
        acis: remoteParticipants.map(({ aci }) => aci),
        maxDevices: Infinity,
        deviceCount: remoteParticipants.length,
      };

    let newActiveCallState: ActiveCallStateType | undefined;
    if (state.activeCallState?.conversationId === conversationId) {
      newActiveCallState =
        connectionState === GroupCallConnectionState.NotConnected
          ? undefined
          : {
              ...state.activeCallState,
              hasLocalAudio,
              hasLocalVideo,
            };
    } else {
      newActiveCallState = state.activeCallState;
    }

    if (
      newActiveCallState &&
      newActiveCallState.outgoingRing &&
      newActiveCallState.conversationId === conversationId &&
      isAnybodyElseInGroupCall(newPeekInfo, ourAci)
    ) {
      newActiveCallState = {
        ...newActiveCallState,
        outgoingRing: false,
      };
    }

    let newRingState: GroupCallRingStateType;
    if (joinState === GroupCallJoinState.NotJoined) {
      newRingState = existingRingState;
    } else {
      newRingState = {};
    }

    const call = {
      callMode,
      conversationId,
      connectionState,
      joinState,
      localDemuxId,
      peekInfo: newPeekInfo,
      remoteParticipants,
      raisedHands: existingCall?.raisedHands ?? [],
      ...newRingState,
    };

    return {
      ...state,
      ...mergeCallWithGroupCallLookups({
        state,
        callMode,
        conversationId,
        call,
      }),
      activeCallState: newActiveCallState,
    };
  }

  if (action.type === PEEK_GROUP_CALL_FULFILLED) {
    const { callMode, conversationId, peekInfo } = action.payload;
    if (!isGroupOrAdhocCallMode(callMode)) {
      return state;
    }

    const existingCall: GroupCallStateType = getGroupCall(
      conversationId,
      state,
      callMode
    ) || {
      callMode,
      conversationId,
      connectionState: GroupCallConnectionState.NotConnected,
      joinState: GroupCallJoinState.NotJoined,
      localDemuxId: undefined,
      peekInfo: {
        acis: [],
        maxDevices: Infinity,
        deviceCount: 0,
      },
      remoteParticipants: [],
    };

    // This action should only update non-connected group calls. It's not necessarily a
    //   mistake if this action is dispatched "over" a connected call. Here's a valid
    //   sequence of events:
    //
    // 1. We ask RingRTC to peek, kicking off an asynchronous operation.
    // 2. The associated group call is joined.
    // 3. The peek promise from step 1 resolves.
    if (
      existingCall.connectionState !== GroupCallConnectionState.NotConnected
    ) {
      return state;
    }

    return {
      ...state,
      ...mergeCallWithGroupCallLookups({
        state,
        callMode: existingCall.callMode,
        conversationId,
        call: { ...existingCall, peekInfo },
      }),
    };
  }

  if (
    action.type === SEND_GROUP_CALL_REACTION ||
    action.type === GROUP_CALL_REACTIONS_RECEIVED
  ) {
    const { callMode, conversationId, timestamp } = action.payload;
    if (state.activeCallState?.conversationId !== conversationId) {
      return state;
    }

    let recentReactions: Array<ActiveCallReaction> = [];
    if (action.type === GROUP_CALL_REACTIONS_RECEIVED) {
      recentReactions = action.payload.reactions.map(({ demuxId, value }) => {
        return { timestamp, demuxId, value };
      });
    } else {
      // When sending reactions, ringrtc doesn't automatically receive back a copy of
      // the reaction you just sent. We handle it here and add a local copy to state.
      const existingGroupCall = getGroupCall(conversationId, state, callMode);
      if (!existingGroupCall) {
        log.warn(
          'Unable to update group call reactions after send reaction because existing group call is missing.'
        );
        return state;
      }

      // This should never happen -- localDemuxId is set when a call enters the
      // Joining state, and Reactions are only usable from the CallScreen which is
      // shown when the call is in the Joined state (after Joining).
      if (!existingGroupCall.localDemuxId) {
        log.warn(
          'Unable to update group call reactions after send reaction because localDemuxId is missing.'
        );
        return state;
      }

      recentReactions = [
        {
          timestamp,
          demuxId: existingGroupCall.localDemuxId,
          value: action.payload.value,
        },
      ];
    }

    return {
      ...state,
      activeCallState: {
        ...state.activeCallState,
        reactions: [
          ...(state.activeCallState.reactions ?? []),
          ...recentReactions,
        ].slice(-MAX_CALLING_REACTIONS),
      },
    };
  }

  if (action.type === GROUP_CALL_REACTIONS_EXPIRED) {
    const { conversationId, timestamp: receivedAt } = action.payload;
    if (
      state.activeCallState?.conversationId !== conversationId ||
      !state.activeCallState?.reactions
    ) {
      return state;
    }

    const expireAt = receivedAt + CALLING_REACTIONS_LIFETIME;

    return {
      ...state,
      activeCallState: {
        ...state.activeCallState,
        reactions: state.activeCallState.reactions.filter(({ timestamp }) => {
          return timestamp > expireAt;
        }),
      },
    };
  }

  if (action.type === GROUP_CALL_RAISED_HANDS_CHANGE) {
    const { callMode, conversationId, raisedHands } = action.payload;

    const { activeCallState } = state;
    const existingCall = getGroupCall(conversationId, state, callMode);

    if (
      state.activeCallState?.conversationId !== conversationId ||
      !activeCallState ||
      !existingCall
    ) {
      return state;
    }

    return {
      ...state,
      ...mergeCallWithGroupCallLookups({
        state,
        callMode: existingCall.callMode,
        conversationId,
        call: { ...existingCall, raisedHands: [...raisedHands] },
      }),
    };
  }

  if (action.type === REMOTE_SHARING_SCREEN_CHANGE) {
    const { conversationId, isSharingScreen } = action.payload;
    const call = getOwn(state.callsByConversation, conversationId);
    if (call?.callMode !== CallMode.Direct) {
      log.warn('Cannot update remote video for a non-direct call');
      return state;
    }

    return {
      ...state,
      callsByConversation: {
        ...callsByConversation,
        [conversationId]: {
          ...call,
          isSharingScreen,
        },
      },
    };
  }

  if (action.type === REMOTE_VIDEO_CHANGE) {
    const { conversationId, hasVideo } = action.payload;
    const call = getOwn(state.callsByConversation, conversationId);
    if (call?.callMode !== CallMode.Direct) {
      log.warn('Cannot update remote video for a non-direct call');
      return state;
    }

    return {
      ...state,
      callsByConversation: {
        ...callsByConversation,
        [conversationId]: {
          ...call,
          hasRemoteVideo: hasVideo,
        },
      },
    };
  }

  if (action.type === RETURN_TO_ACTIVE_CALL) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot return to active call if there is no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        pip: false,
      },
    };
  }

  if (action.type === SET_LOCAL_AUDIO_FULFILLED) {
    if (!state.activeCallState) {
      log.warn('Cannot set local audio with no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...state.activeCallState,
        hasLocalAudio: action.payload.enabled,
      },
    };
  }

  if (action.type === SET_LOCAL_VIDEO_FULFILLED) {
    if (!state.activeCallState) {
      log.warn('Cannot set local video with no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...state.activeCallState,
        hasLocalVideo: action.payload.enabled,
      },
    };
  }

  if (action.type === CHANGE_IO_DEVICE_FULFILLED) {
    const { selectedDevice } = action.payload;
    const nextState = Object.create(null);

    if (action.payload.type === CallingDeviceType.CAMERA) {
      nextState.selectedCamera = selectedDevice;
    } else if (action.payload.type === CallingDeviceType.MICROPHONE) {
      nextState.selectedMicrophone = selectedDevice;
    } else if (action.payload.type === CallingDeviceType.SPEAKER) {
      nextState.selectedSpeaker = selectedDevice;
    }

    return {
      ...state,
      ...nextState,
    };
  }

  if (action.type === REFRESH_IO_DEVICES) {
    const {
      availableMicrophones,
      selectedMicrophone,
      availableSpeakers,
      selectedSpeaker,
      availableCameras,
      selectedCamera,
    } = action.payload;

    return {
      ...state,
      availableMicrophones,
      selectedMicrophone,
      availableSpeakers,
      selectedSpeaker,
      availableCameras,
      selectedCamera,
    };
  }

  if (action.type === TOGGLE_SETTINGS) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot toggle settings when there is no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        settingsDialogOpen: !activeCallState.settingsDialogOpen,
      },
    };
  }

  if (action.type === TOGGLE_PARTICIPANTS) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot toggle participants list when there is no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        showParticipantsList: !activeCallState.showParticipantsList,
      },
    };
  }

  if (action.type === TOGGLE_PIP) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot toggle PiP when there is no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        pip: !activeCallState.pip,
      },
    };
  }

  if (action.type === SET_PRESENTING) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot toggle presenting when there is no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        presentingSource: action.payload,
        presentingSourcesAvailable: undefined,
      },
    };
  }

  if (action.type === SET_PRESENTING_SOURCES) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot set presenting sources when there is no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        presentingSourcesAvailable: action.payload,
      },
    };
  }

  if (action.type === SET_OUTGOING_RING) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot set outgoing ring when there is no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        outgoingRing: action.payload,
      },
    };
  }

  if (action.type === TOGGLE_NEEDS_SCREEN_RECORDING_PERMISSIONS) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot set presenting sources when there is no active call');
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        showNeedsScreenRecordingPermissionsWarning:
          !activeCallState.showNeedsScreenRecordingPermissionsWarning,
      },
    };
  }

  if (action.type === CHANGE_CALL_VIEW) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot change call view when there is no active call');
      return state;
    }

    if (activeCallState.viewMode === action.viewMode) {
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        viewMode: action.viewMode,
        viewModeBeforePresentation:
          action.viewMode === CallViewMode.Presentation
            ? activeCallState.viewMode
            : undefined,
      },
    };
  }

  if (action.type === SWITCH_TO_PRESENTATION_VIEW) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot switch to speaker view when there is no active call');
      return state;
    }

    if (activeCallState.viewMode === CallViewMode.Presentation) {
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        viewMode: CallViewMode.Presentation,
        viewModeBeforePresentation: activeCallState.viewMode,
      },
    };
  }

  if (action.type === SWITCH_FROM_PRESENTATION_VIEW) {
    const { activeCallState } = state;
    if (!activeCallState) {
      log.warn('Cannot switch to speaker view when there is no active call');
      return state;
    }

    if (activeCallState.viewMode !== CallViewMode.Presentation) {
      return state;
    }

    return {
      ...state,
      activeCallState: {
        ...activeCallState,
        viewMode:
          activeCallState.viewModeBeforePresentation ?? CallViewMode.Paginated,
      },
    };
  }

  return state;
}
