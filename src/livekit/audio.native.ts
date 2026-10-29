import { Platform } from 'react-native';
import { AudioSession, AndroidAudioTypePresets } from '@livekit/react-native';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';

export async function startCallAudio() {
  const perm = await getRecordingPermissionsAsync();
  if (!perm.granted) {
    const req = await requestRecordingPermissionsAsync();
    if (!req.granted) throw new Error('Microphone permission is required for calls. Please allow it in Settings.');
  }
  await AudioSession.configureAudio({
    android: {
      preferredOutputList: ['speaker', 'earpiece', 'headset', 'bluetooth'],
      audioTypeOptions: AndroidAudioTypePresets.communication,
    },
    // iOS: the "default" route is the earpiece (or headphones when connected);
    // loudspeaker is chosen explicitly with setSpeakerphone(true). With
    // defaultOutput 'speaker' + 'defaultToSpeaker', turning the speaker OFF
    // had no effect without headphones (default WAS the speaker).
    ios: {
      defaultOutput: 'earpiece',
    },
  }).catch((e) => console.warn('[LiveKitAudio] configureAudio failed:', e));

  if (Platform.OS === 'ios') {
    await AudioSession.setAppleAudioConfiguration({
      audioCategory: 'playAndRecord',
      audioMode: 'voiceChat',
      audioCategoryOptions: ['allowBluetooth', 'allowBluetoothA2DP'],
    }).catch((e) => console.warn('[LiveKitAudio] iOS audio setup failed:', e));
  }

  await AudioSession.startAudioSession();
  // The output (speaker / earpiece / headphones) is chosen by useLiveKitCall.
}

/**
 * Are headphones or a Bluetooth headset connected? Android can tell; iOS
 * doesn't expose it here, so it returns false there (the call then starts on
 * the loudspeaker and the user can switch).
 */
export async function hasHeadphones(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const outputs = await AudioSession.getAudioOutputs();
    return outputs.some((o) => o === 'headset' || o === 'bluetooth');
  } catch {
    return false;
  }
}

export async function stopCallAudio() {
  await AudioSession.stopAudioSession();
}

/**
 * Loudspeaker on/off.
 * Android: 'speaker' / 'earpiece' (earpiece also covers wired/Bluetooth via the system).
 * iOS: 'force_speaker' / 'default' (default = earpiece, or headphones when connected).
 */
export async function setSpeakerphone(on: boolean) {
  const target = Platform.OS === 'ios' ? (on ? 'force_speaker' : 'default') : (on ? 'speaker' : 'earpiece');
  try {
    await AudioSession.selectAudioOutput(target);
  } catch (err) {
    console.warn('[LiveKitAudio] selectAudioOutput failed:', err);
  }
}
