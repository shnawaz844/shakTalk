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
  Linking,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useUser, useAuth } from '@clerk/clerk-expo';
import { API_URL } from '../config';
import { TERMS_URL, PRIVACY_URL, SUPPORT_URL } from '../legal/legal';
import { Alert } from '../utils/alertCompat';
import * as ImagePicker from 'expo-image-picker';
import { LanguageSelector } from '../components/LanguageSelector';
import { setStoredEngine, setStoredPlanTier, CallEngine, PlanTier } from '../utils/enginePreference';
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
  const { getToken, signOut } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const handleRestorePurchases = async () => {
    try {
      setRestoring(true);
      const token = await getToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`${API_URL}/user/account-state`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();

      if (data.ok) {
        if (data.hasPurchasedPlan) {
          await setStoredEngine(data.planEngine as CallEngine);
          await setStoredPlanTier(data.planTier as PlanTier);
          const planName = data.planTier === 'business' ? 'Dual AI All-Access' : (data.planTier === 'pro' ? 'Pro Plan' : 'Base Plan');
          Alert.alert(
            'Account Restored! 🎉',
            `Your ${planName} subscription is active with ${data.totalMinutes} total minutes available across your plan and wallet.`
          );
        } else {
          Alert.alert(
            'Account Verified',
            `Your wallet has ${data.walletMinutes || 0} minutes available. No active monthly subscription was found for this account.`
          );
        }
      } else {
        throw new Error(data.error || 'Could not restore account');
      }
    } catch (err: any) {
      Alert.alert('Restore Notice', err.message || 'Could not sync account state.');
    } finally {
      setRestoring(false);
    }
  };
  const meta = user?.unsafeMetadata as any;

  // Account deletion (required by Apple and Google). Deletes data on the
  // server, then the login itself, then signs out on this phone.
  const runDelete = async () => {
    try {
      setDeleting(true);
      const token = await getToken();
      const res = await fetch(`${API_URL}/account/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 207) throw new Error(`Server error (${res.status})`);
      await signOut().catch(() => {});
      Alert.alert('Account deleted', 'Your ShakTalk account and data have been deleted.');
    } catch (err: any) {
      Alert.alert('Could not delete account', `${err?.message ?? 'Please try again.'}\n\nYou can also email support to delete it for you.`);
    } finally {
      setDeleting(false);
    }
  };
  const confirmDelete = () => {
    Alert.alert(
      'Delete your account?',
      'This permanently deletes your account, profile, conversation history and recordings. It cannot be undone. App Store or Google Play subscriptions must be cancelled separately in your store settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: () => { void runDelete(); } },
      ],
    );
  };
  const [firstName, setFirstName] = useState(user?.firstName || '');
  const [lastName, setLastName] = useState(user?.lastName || '');
  const [gender, setGender] = useState<Gender>(meta?.gender || 'neutral');
  const [age, setAge] = useState(String(meta?.age ?? ''));
  const [nativeLanguage, setNativeLanguage] = useState<string>(meta?.nativeLanguage || 'English');
  const [isUpdating, setIsUpdating] = useState(false);

  const handleUpdateProfile = async () => {
    if (!user) return;
    const parsedAge = parseInt(age, 10);
    if (Number.isFinite(parsedAge) && parsedAge < 18) {
      Alert.alert('Age', 'ShakTalk is only for people aged 18 and over.');
      return;
    }
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

          <View style={styles.manageSubscriptionCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
              <Feather name="credit-card" size={16} color="#2FE0A8" style={{ marginRight: 8 }} />
              <Text style={styles.manageSubscriptionTitle}>Manage Subscription</Text>
            </View>
            <Text style={styles.manageSubscriptionSub}>
              Plans and minutes are managed securely via Apple App Store or Google Play. View, upgrade, or cancel your monthly subscription anytime.
            </Text>
            <TouchableOpacity
              style={styles.manageStoreBtn}
              onPress={() => {
                const storeUrl = Platform.OS === 'ios'
                  ? 'https://apps.apple.com/account/subscriptions'
                  : 'https://play.google.com/store/account/subscriptions';
                Linking.openURL(storeUrl).catch(() => {});
              }}
              activeOpacity={0.8}
            >
              <Feather name="external-link" size={14} color="#000" style={{ marginRight: 6 }} />
              <Text style={styles.manageStoreBtnText}>Open Store Subscriptions</Text>
            </TouchableOpacity>
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

          {/* Restore Purchases & Sync Plan */}
          <TouchableOpacity
            style={styles.restoreBtn}
            onPress={handleRestorePurchases}
            disabled={restoring}
            activeOpacity={0.8}
          >
            {restoring ? (
              <ActivityIndicator color="#2FE0A8" size="small" />
            ) : (
              <>
                <Feather name="refresh-cw" size={16} color="#2FE0A8" style={{ marginRight: 8 }} />
                <Text style={styles.restoreBtnText}>Restore Plan & Sync Credits</Text>
              </>
            )}
          </TouchableOpacity>

          <View style={styles.legalRow}>
            <Text style={styles.legalLink} onPress={() => Linking.openURL(TERMS_URL)}>Terms of Use</Text>
            <Text style={styles.legalDot}>·</Text>
            <Text style={styles.legalLink} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
            <Text style={styles.legalDot}>·</Text>
            <Text style={styles.legalLink} onPress={() => Linking.openURL(SUPPORT_URL)}>Support</Text>
          </View>

          <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete} disabled={deleting}>
            {deleting ? (
              <ActivityIndicator color="#E85C5C" size="small" />
            ) : (
              <>
                <Feather name="trash-2" size={16} color="#E85C5C" style={{ marginRight: 8 }} />
                <Text style={styles.deleteBtnText}>Delete account</Text>
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
  legalRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 28, flexWrap: 'wrap' },
  legalLink: { color: 'rgba(255,255,255,0.55)', fontSize: 13, textDecorationLine: 'underline' },
  legalDot: { color: 'rgba(255,255,255,0.3)' },
  deleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 20, marginBottom: 8, height: 50, borderRadius: 14,
    borderWidth: 1, borderColor: 'rgba(232,92,92,0.4)',
  },
  deleteBtnText: { color: '#E85C5C', fontSize: 15, fontWeight: '700' },
  saveBtnText: { color: '#000', fontSize: 16, fontWeight: '800' },
  restoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(47, 224, 168, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.3)',
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 12,
  },
  restoreBtnText: {
    color: '#2FE0A8',
    fontSize: 15,
    fontWeight: '700',
  },
  manageSubscriptionCard: {
    backgroundColor: '#121615',
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.25)',
    borderRadius: 16,
    padding: 16,
    marginVertical: 14,
  },
  manageSubscriptionTitle: {
    color: '#2FE0A8',
    fontSize: 15,
    fontWeight: '700',
  },
  manageSubscriptionSub: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  manageStoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2FE0A8',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  manageStoreBtnText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '700',
  },
});
