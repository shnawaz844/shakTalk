import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useUser } from '@clerk/clerk-expo';
import { Alert } from '../utils/alertCompat';
import * as ImagePicker from 'expo-image-picker';
import { LanguageSelector } from '../components/LanguageSelector';
import { ModelSwitcher } from '../components/ModelSwitcher';
import { CallEngine, getStoredEngine, subscribeEngineChange } from '../utils/enginePreference';
import type { Gender } from './OnboardingScreen';

interface ProfileScreenProps {
  onBack: () => void;
}

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'neutral', label: 'Prefer not to say' },
];

export function ProfileScreen({ onBack }: ProfileScreenProps) {
  const { user } = useUser();
  const meta = user?.unsafeMetadata as any;
  const [firstName, setFirstName] = useState(user?.firstName || '');
  const [lastName, setLastName] = useState(user?.lastName || '');
  const [gender, setGender] = useState<Gender>(meta?.gender || 'neutral');
  const [age, setAge] = useState(String(meta?.age ?? ''));
  const [nativeLanguage, setNativeLanguage] = useState<string>(meta?.nativeLanguage || 'English');
  const [isUpdating, setIsUpdating] = useState(false);
  const [engine, setEngine] = useState<CallEngine>('legacy');

  React.useEffect(() => {
    getStoredEngine().then(setEngine);
    const unsub = subscribeEngineChange(setEngine);
    return unsub;
  }, []);

  const handleUpdateProfile = async () => {
    if (!user) return;
    const parsedAge = parseInt(age, 10);
    try {
      setIsUpdating(true);
      await user.update({ firstName, lastName });
      await user.update({
        unsafeMetadata: {
          ...(user.unsafeMetadata as object),
          gender,
          age: Number.isFinite(parsedAge) ? parsedAge : meta?.age,
          nativeLanguage,
          onboardingComplete: true,
        },
      });
      Alert.alert('Success', 'Profile updated successfully!');
    } catch (err: any) {
      console.error('Update profile error', err);
      Alert.alert('Error', err.errors?.[0]?.message || 'Failed to update profile');
    } finally {
      setIsUpdating(false);
    }
  };

  const handlePickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.5,
        base64: true,
      });

      if (!result.canceled && result.assets[0].base64) {
        setIsUpdating(true);
        const base64 = `data:image/jpeg;base64,${result.assets[0].base64}`;
        await user?.setProfileImage({
          file: base64,
        });
        setIsUpdating(false);
      }
    } catch (err: any) {
      console.error('Pick image error', err);
      Alert.alert('Error', 'Failed to update profile image');
      setIsUpdating(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topGlow} />

      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Feather name="arrow-left" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Edit Profile</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Profile Image */}
        <View style={styles.imageSection}>
          <View style={styles.imageWrapper}>
            {user?.imageUrl ? (
              <Image source={{ uri: user.imageUrl }} style={styles.profileImage} />
            ) : (
              <View style={styles.imagePlaceholder}>
                <Feather name="user" size={40} color="rgba(255,255,255,0.2)" />
              </View>
            )}
            <TouchableOpacity 
              style={styles.editImageBtn} 
              onPress={handlePickImage}
              disabled={isUpdating}
            >
              <Feather name="camera" size={16} color="#000" />
            </TouchableOpacity>
          </View>
          <Text style={styles.emailText}>{user?.primaryEmailAddress?.emailAddress}</Text>
        </View>

        {/* Form */}
        <View style={styles.form}>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>FIRST NAME</Text>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.input}
                value={firstName}
                onChangeText={setFirstName}
                placeholder="Enter first name"
                placeholderTextColor="rgba(255,255,255,0.2)"
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>LAST NAME</Text>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.input}
                value={lastName}
                onChangeText={setLastName}
                placeholder="Enter last name"
                placeholderTextColor="rgba(255,255,255,0.2)"
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>AGE</Text>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.input}
                value={age}
                onChangeText={(v) => setAge(v.replace(/[^0-9]/g, ''))}
                placeholder="Enter your age"
                placeholderTextColor="rgba(255,255,255,0.2)"
                keyboardType="number-pad"
                maxLength={3}
              />
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>GENDER</Text>
            <View style={styles.pillRow}>
              {GENDER_OPTIONS.map((opt) => {
                const active = gender === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[styles.pill, active && styles.pillActive]}
                    onPress={() => setGender(opt.value)}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.pillText, active && styles.pillTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>NATIVE LANGUAGE</Text>
            <Text style={styles.hint}>
              Used as your default language on the home screen until you pick a different one there.
            </Text>
            <LanguageSelector label="" selected={nativeLanguage} onSelect={setNativeLanguage} />
          </View>

          {/* Active Translation Model Section */}
          <View style={styles.activeModelShowcase}>
            <View style={styles.activeModelTopRow}>
              <View style={styles.activeModelBadge}>
                <View style={[styles.activeDot, { backgroundColor: engine === 'livekit' ? '#2FE0A8' : '#39FF14' }]} />
                <Text style={[styles.activeModelTag, { color: engine === 'livekit' ? '#2FE0A8' : '#39FF14' }]}>
                  ACTIVE TRANSLATION MODEL
                </Text>
              </View>
              <View style={[styles.tierTag, { borderColor: engine === 'livekit' ? '#2FE0A8' : '#39FF14' }]}>
                <Text style={[styles.tierTagText, { color: engine === 'livekit' ? '#2FE0A8' : '#39FF14' }]}>
                  {engine === 'livekit' ? '3.5 LIVE' : '2.5 FLASH'}
                </Text>
              </View>
            </View>

            <Text style={styles.activeModelTitle}>
              {engine === 'livekit' ? 'Gemini 3.5 Live Translate' : 'Gemini 2.5 Flash Native Audio'}
            </Text>
            <Text style={styles.activeModelSubtitle}>
              {engine === 'livekit'
                ? 'Ultra-low latency simultaneous speech translation over LiveKit WebRTC.'
                : 'Turn-by-turn conversational translation over Vertex AI with full audio recording.'}
            </Text>

            <View style={styles.modelFeatureList}>
              <View style={styles.modelFeatureItem}>
                <Feather name="check-circle" size={12} color={engine === 'livekit' ? '#2FE0A8' : '#39FF14'} />
                <Text style={styles.modelFeatureText}>
                  {engine === 'livekit' ? 'Engine: LiveKit WebRTC Streaming' : 'Engine: Vertex AI Native Audio'}
                </Text>
              </View>
              <View style={styles.modelFeatureItem}>
                <Feather name="check-circle" size={12} color={engine === 'livekit' ? '#2FE0A8' : '#39FF14'} />
                <Text style={styles.modelFeatureText}>
                  {`Voice: Locked to ${gender === 'female' ? 'Female (Aoede)' : 'Male (Puck)'}`}
                </Text>
              </View>
            </View>

            <View style={{ marginTop: 14 }}>
              <ModelSwitcher />
            </View>
          </View>

          <TouchableOpacity
            style={[styles.saveBtn, isUpdating && styles.saveBtnDisabled]}
            onPress={handleUpdateProfile}
            disabled={isUpdating}
          >
            {isUpdating ? (
              <ActivityIndicator color="#000" size="small" />
            ) : (
              <>
                <Feather name="check" size={20} color="#000" style={{ marginRight: 8 }} />
                <Text style={styles.saveBtnText}>Save Changes</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  topGlow: {
    position: 'absolute', top: -100, right: -100,
    width: 300, height: 300, borderRadius: 150,
    backgroundColor: '#39FF14', opacity: 0.05,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center', alignItems: 'center',
  },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  scroll: { padding: 24 },
  imageSection: { alignItems: 'center', marginBottom: 40 },
  imageWrapper: {
    position: 'relative',
    width: 100, height: 100, borderRadius: 50,
    marginBottom: 16,
  },
  profileImage: { width: 100, height: 100, borderRadius: 50 },
  imagePlaceholder: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: '#111', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', alignItems: 'center',
  },
  editImageBtn: {
    position: 'absolute', bottom: 0, right: 0,
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#39FF14',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 3, borderColor: '#0A0A0A',
  },
  emailText: { color: 'rgba(255,255,255,0.4)', fontSize: 14 },
  form: { gap: 24 },
  inputGroup: { gap: 10 },
  label: {
    color: 'rgba(255,255,255,0.3)', fontSize: 10,
    fontFamily: 'Courier', letterSpacing: 2,
  },
  inputContainer: {
    backgroundColor: '#111', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 16, paddingHorizontal: 16, height: 56, justifyContent: 'center',
  },
  input: { color: '#fff', fontSize: 16 },
  hint: {
    color: 'rgba(255,255,255,0.25)', fontSize: 11, lineHeight: 15, marginTop: -4,
  },
  pillRow: { flexDirection: 'row', gap: 10 },
  pill: {
    flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  pillActive: {
    backgroundColor: 'rgba(57,255,20,0.1)',
    borderColor: '#39FF14',
  },
  pillText: {
    color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: '600', textAlign: 'center',
  },
  pillTextActive: { color: '#39FF14' },
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#39FF14', borderRadius: 16, height: 56,
    marginTop: 12,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: '#000', fontSize: 16, fontWeight: '800' },

  activeModelShowcase: {
    backgroundColor: '#121714',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  activeModelTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  activeModelBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activeDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  activeModelTag: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  tierTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  tierTagText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  activeModelTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 6,
  },
  activeModelSubtitle: {
    color: '#8A9793',
    fontSize: 12.5,
    lineHeight: 18,
    marginBottom: 14,
  },
  modelFeatureList: {
    gap: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.04)',
  },
  modelFeatureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  modelFeatureText: {
    color: '#D1DBD7',
    fontSize: 12,
    fontWeight: '500',
  },
});
