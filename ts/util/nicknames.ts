// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as RemoteConfig from '../RemoteConfig';

export function areNicknamesEnabled(): boolean {
  return RemoteConfig.getValue('desktop.nicknames') === 'TRUE';
}
