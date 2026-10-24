import { Platform } from 'react-native';
import { AudioSession, AndroidAudioTypePresets } from '@livekit/react-native';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';

export async function startCallAudio() {
  const perm = await getRecordingPermissionsAsync();
  if (!perm.granted) {
    const req = await requestRecordingPermissionsAsync();
    if (!req.granted) throw new Error('Microphone permission is required for calls. Please allow it in Settings.');
  }
  if (Platform.OS === 'android') {
    await AudioSession.configureAudio({
      android: {
        audioTypeOptions: AndroidAudioTypePresets.communication,
      },
    }).catch((e) => console.warn('[LiveKitAudio] configureAudio failed:', e));
  }

  if (Platform.OS === 'ios') {
    await AudioSession.setAppleAudioConfiguration({
      audioCategory: 'playAndRecord',
      audioMode: 'voiceChat',
      audioCategoryOptions: ['allowBluetooth', 'defaultToSpeaker', 'allowBluetoothA2DP'],
    }).catch((e) => console.warn('[LiveKitAudio] iOS audio setup failed:', e));
  }

  await AudioSession.startAudioSession();
}

export async function stopCallAudio() {
  await AudioSession.stopAudioSession();
}

/** Loudspeaker on/off. Android: speaker/earpiece. iOS: force_speaker/default. */
export async function setSpeakerphone(on: boolean) {
  const target = Platform.OS === 'ios' ? (on ? 'force_speaker' : 'default') : (on ? 'speaker' : 'earpiece');
  const outputs = await AudioSession.getAudioOutputs();
  // A headset or Bluetooth device takes priority; only switch between built-in outputs.
  if (!outputs.includes(target)) return;
  if (!on && Platform.OS === 'android' && (outputs.includes('headset') || outputs.includes('bluetooth'))) return;
  await AudioSession.selectAudioOutput(target);
}
