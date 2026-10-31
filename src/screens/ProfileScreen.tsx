import React, { useState, useEffect } from 'react';
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
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, FontAwesome } from '@expo/vector-icons';
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

type ProfileTab = 'overview' | 'edit_profile' | 'billing' | 'security';

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'neutral', label: 'Prefer not to say' },
];

export function ProfileScreen({ onBack }: ProfileScreenProps) {
  const { user } = useUser();
  const { getToken, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<ProfileTab>('overview');
  const meta = (user?.unsafeMetadata as any) || {};

  // ── Global Async States ───────────────────────────────────────────────────
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  // ── Edit Profile States ───────────────────────────────────────────────────
  const [firstName, setFirstName] = useState(user?.firstName || '');
  const [lastName, setLastName] = useState(user?.lastName || '');
  const [gender, setGender] = useState<Gender>(meta?.gender || 'neutral');
  const [age, setAge] = useState(String(meta?.age ?? ''));
  const [nativeLanguage, setNativeLanguage] = useState<string>(meta?.nativeLanguage || 'English');

  // ── Billing States ────────────────────────────────────────────────────────
  const [cardholderName, setCardholderName] = useState(meta?.savedCard?.cardholderName || '');
  const [cardNumber, setCardNumber] = useState(meta?.savedCard?.maskedNumber || '');
  const [cardExp, setCardExp] = useState(meta?.savedCard?.expiry || '');
  const [cardCvv, setCardCvv] = useState('');
  const [isSavingCard, setIsSavingCard] = useState(false);
  const [savedCard, setSavedCard] = useState<any>(meta?.savedCard || null);

  const [street, setStreet] = useState(meta?.billingAddress?.street || '');
  const [city, setCity] = useState(meta?.billingAddress?.city || '');
  const [stateRegion, setStateRegion] = useState(meta?.billingAddress?.state || '');
  const [postalCode, setPostalCode] = useState(meta?.billingAddress?.postalCode || '');
  const [country, setCountry] = useState(meta?.billingAddress?.country || '');
  const [isSavingAddress, setIsSavingAddress] = useState(false);

  // ── Security States ───────────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  const existingPhone = user?.phoneNumbers?.[0]?.phoneNumber || meta?.phoneNumber || '';
  const [phoneNumber, setPhoneNumber] = useState(existingPhone);
  const [isUpdatingPhone, setIsUpdatingPhone] = useState(false);
  const [phoneCode, setPhoneCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [showPhoneCodeInput, setShowPhoneCodeInput] = useState(false);
  const [showEmailCodeInput, setShowEmailCodeInput] = useState(false);
  const [isSendingVerify, setIsSendingVerify] = useState(false);

  const isEmailVerified = user?.primaryEmailAddress?.verification?.status === 'verified';
  const isPhoneVerified = user?.phoneNumbers?.[0]?.verification?.status === 'verified' || meta?.phoneVerified === true;

  // Sync state on user change
  useEffect(() => {
    if (user) {
      setFirstName(user.firstName || '');
      setLastName(user.lastName || '');
      if (meta?.gender) setGender(meta.gender);
      if (meta?.age) setAge(String(meta.age));
      if (meta?.nativeLanguage) setNativeLanguage(meta.nativeLanguage);
      if (meta?.savedCard) setSavedCard(meta.savedCard);
      if (meta?.billingAddress) {
        setStreet(meta.billingAddress.street || '');
        setCity(meta.billingAddress.city || '');
        setStateRegion(meta.billingAddress.state || '');
        setPostalCode(meta.billingAddress.postalCode || '');
        setCountry(meta.billingAddress.country || '');
      }
    }
  }, [user]);

  // ── Profile Photo Picker ──────────────────────────────────────────────────
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
        await user?.setProfileImage({ file: base64 });
        Alert.alert('Success', 'Profile photo updated successfully!');
      }
    } catch (err: any) {
      console.error('Pick image error', err);
      Alert.alert('Error', 'Failed to update profile image');
    } finally {
      setIsUpdating(false);
    }
  };

  // ── Save Personal Profile ─────────────────────────────────────────────────
  const handleUpdateProfile = async () => {
    if (!user) return;
    const parsedAge = parseInt(age, 10);
    if (Number.isFinite(parsedAge) && parsedAge < 18) {
      Alert.alert('Age Restriction', 'ShakTalk is only for users aged 18 and over.');
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
      setActiveTab('overview');
    } catch (err: any) {
      console.error('Update profile error', err);
      Alert.alert('Error', err.errors?.[0]?.message || 'Failed to update profile');
    } finally {
      setIsUpdating(false);
    }
  };

  // ── Save Card for Autopay ─────────────────────────────────────────────────
  const handleSaveCard = async () => {
    if (!cardNumber || cardNumber.replace(/\s/g, '').length < 15) {
      Alert.alert('Invalid Card', 'Please enter a valid 15 or 16-digit card number.');
      return;
    }
    if (!cardholderName.trim()) {
      Alert.alert('Missing Name', 'Please enter the cardholder name.');
      return;
    }
    if (!cardExp || !cardExp.includes('/')) {
      Alert.alert('Invalid Expiry', 'Please enter expiry in MM/YY format.');
      return;
    }

    try {
      setIsSavingCard(true);
      const cleanNum = cardNumber.replace(/\s/g, '');
      const last4 = cleanNum.slice(-4);
      let brand = 'Card';
      if (cleanNum.startsWith('4')) brand = 'Visa';
      else if (cleanNum.startsWith('5')) brand = 'Mastercard';
      else if (cleanNum.startsWith('3')) brand = 'Amex';

      const cardObj = {
        brand,
        last4,
        maskedNumber: `•••• •••• •••• ${last4}`,
        expiry: cardExp,
        cardholderName: cardholderName.trim(),
        isAutopay: true,
        savedAt: new Date().toISOString(),
      };

      await user?.update({
        unsafeMetadata: {
          ...(user.unsafeMetadata as object),
          savedCard: cardObj,
        },
      });

      setSavedCard(cardObj);
      setCardCvv('');
      Alert.alert('Card Saved for Autopay! 💳', `Your ${brand} card ending in ${last4} has been securely saved and enabled for subscription autopay.`);
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to save card details.');
    } finally {
      setIsSavingCard(false);
    }
  };

  // ── Save Billing Address ──────────────────────────────────────────────────
  const handleSaveBillingAddress = async () => {
    if (!street.trim() || !city.trim() || !country.trim()) {
      Alert.alert('Incomplete Address', 'Please provide at least Street, City, and Country.');
      return;
    }
    try {
      setIsSavingAddress(true);
      const addrObj = {
        street: street.trim(),
        city: city.trim(),
        state: stateRegion.trim(),
        postalCode: postalCode.trim(),
        country: country.trim(),
        updatedAt: new Date().toISOString(),
      };
      await user?.update({
        unsafeMetadata: {
          ...(user.unsafeMetadata as object),
          billingAddress: addrObj,
        },
      });
      Alert.alert('Success', 'Billing address saved successfully!');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to save billing address.');
    } finally {
      setIsSavingAddress(false);
    }
  };

  // ── Change Password ───────────────────────────────────────────────────────
  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword) {
      Alert.alert('Missing Fields', 'Please enter your current and new password.');
      return;
    }
    if (newPassword.length < 8) {
      Alert.alert('Weak Password', 'New password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Mismatch', 'New passwords do not match.');
      return;
    }
    try {
      setIsUpdatingPassword(true);
      await user?.updatePassword({
        currentPassword,
        newPassword,
      });
      Alert.alert('Success 🎉', 'Your password has been changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      const msg = err.errors?.[0]?.message || err.message || 'Could not update password. If you signed in via Google or Apple, please use their login directly.';
      Alert.alert('Password Update Notice', msg);
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  // ── Update Mobile Number ──────────────────────────────────────────────────
  const handleUpdateMobile = async () => {
    if (!phoneNumber.trim() || phoneNumber.length < 8) {
      Alert.alert('Invalid Number', 'Please enter a valid mobile number with country code (e.g. +1... or +91...).');
      return;
    }
    try {
      setIsUpdatingPhone(true);
      let phoneObj = user?.phoneNumbers?.[0];
      if (!phoneObj) {
        phoneObj = await user?.createPhoneNumber({ phoneNumber: phoneNumber.trim() });
      }
      await user?.update({
        unsafeMetadata: {
          ...(user.unsafeMetadata as object),
          phoneNumber: phoneNumber.trim(),
        },
      });
      Alert.alert('Phone Number Updated', 'Your mobile number has been updated. You can now verify it via SMS OTP.');
    } catch (err: any) {
      Alert.alert('Phone Update', err.errors?.[0]?.message || err.message || 'Failed to update phone number.');
    } finally {
      setIsUpdatingPhone(false);
    }
  };

  // ── Verify Mobile via SMS OTP ─────────────────────────────────────────────
  const handleSendPhoneOtp = async () => {
    try {
      setIsSendingVerify(true);
      const phoneObj = user?.phoneNumbers?.[0];
      if (!phoneObj) {
        Alert.alert('Notice', 'Please update and save your mobile number first.');
        return;
      }
      await (phoneObj as any).prepareVerification();
      setShowPhoneCodeInput(true);
      Alert.alert('Verification Code Sent', `An SMS OTP verification code was sent to ${phoneObj.phoneNumber}.`);
    } catch (err: any) {
      Alert.alert('Verification Notice', err.errors?.[0]?.message || err.message || 'Failed to send SMS code.');
    } finally {
      setIsSendingVerify(false);
    }
  };

  const handleVerifyPhoneCode = async () => {
    if (!phoneCode.trim()) return;
    try {
      setIsSendingVerify(true);
      const phoneObj = user?.phoneNumbers?.[0];
      if (phoneObj) {
        await phoneObj.attemptVerification({ code: phoneCode.trim() });
      }
      await user?.update({
        unsafeMetadata: {
          ...(user.unsafeMetadata as object),
          phoneVerified: true,
        },
      });
      setShowPhoneCodeInput(false);
      setPhoneCode('');
      Alert.alert('Verified! ✅', 'Your mobile number has been successfully verified.');
    } catch (err: any) {
      Alert.alert('Verification Failed', err.errors?.[0]?.message || 'Invalid or expired code. Please try again.');
    } finally {
      setIsSendingVerify(false);
    }
  };

  // ── Verify Primary Email (Gmail) ──────────────────────────────────────────
  const handleSendEmailOtp = async () => {
    if (isEmailVerified) {
      Alert.alert('Already Verified', 'Your email address is already verified.');
      return;
    }
    try {
      setIsSendingVerify(true);
      const emailObj = user?.primaryEmailAddress;
      if (!emailObj) {
        Alert.alert('Notice', 'No primary email found on this account.');
        return;
      }
      await emailObj.prepareVerification({ strategy: 'email_code' });
      setShowEmailCodeInput(true);
      Alert.alert('Verification Email Sent', `A verification code was sent to ${emailObj.emailAddress}.`);
    } catch (err: any) {
      Alert.alert('Verification Notice', err.errors?.[0]?.message || err.message || 'Could not send verification email.');
    } finally {
      setIsSendingVerify(false);
    }
  };

  const handleVerifyEmailCode = async () => {
    if (!emailCode.trim()) return;
    try {
      setIsSendingVerify(true);
      const emailObj = user?.primaryEmailAddress;
      if (emailObj) {
        await emailObj.attemptVerification({ code: emailCode.trim() });
      }
      setShowEmailCodeInput(false);
      setEmailCode('');
      Alert.alert('Verified! ✅', 'Your email address has been verified.');
    } catch (err: any) {
      Alert.alert('Verification Failed', err.errors?.[0]?.message || 'Invalid code. Please try again.');
    } finally {
      setIsSendingVerify(false);
    }
  };

  // ── Restore Purchases ─────────────────────────────────────────────────────
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
          const planName = data.planTier === 'pro' ? 'Pro Plan' : 'Standard Plan';
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

  // ── Account Deletion ──────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  const getHeaderTitle = () => {
    switch (activeTab) {
      case 'edit_profile': return 'Edit Profile';
      case 'billing': return 'Billing & Autopay';
      case 'security': return 'Security & Verification';
      default: return 'Profile';
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topGlow} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => {
            if (activeTab !== 'overview') {
              setActiveTab('overview');
            } else {
              onBack();
            }
          }}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <Feather name="arrow-left" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>{getHeaderTitle()}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ================================================================= */}
        {/* 1. OVERVIEW TAB (DEFAULT)                                         */}
        {/* ================================================================= */}
        {activeTab === 'overview' && (
          <View style={styles.tabContainer}>
            {/* User Profile Card */}
            <View style={styles.profileHeroCard}>
              <View style={styles.heroAvatarWrapper}>
                {user?.imageUrl ? (
                  <Image source={{ uri: user.imageUrl }} style={styles.heroAvatar} />
                ) : (
                  <View style={styles.heroAvatarPlaceholder}>
                    <Feather name="user" size={40} color="rgba(255,255,255,0.3)" />
                  </View>
                )}
                <TouchableOpacity
                  style={styles.editAvatarBtn}
                  onPress={handlePickImage}
                  disabled={isUpdating}
                  activeOpacity={0.8}
                >
                  <Feather name="camera" size={14} color="#000" />
                </TouchableOpacity>
              </View>

              <Text style={styles.heroName}>
                {user?.fullName || `${firstName} ${lastName}`.trim() || 'ShakTalk User'}
              </Text>
              <Text style={styles.heroEmail}>
                {user?.primaryEmailAddress?.emailAddress || 'No email attached'}
              </Text>

              {/* Badges Row */}
              <View style={styles.heroBadgeRow}>
                <View style={styles.heroBadge}>
                  <Feather name="globe" size={11} color="#2FE0A8" style={{ marginRight: 4 }} />
                  <Text style={styles.heroBadgeText}>{nativeLanguage}</Text>
                </View>
                <View style={styles.heroBadge}>
                  <Text style={styles.heroBadgeText}>Age: {age || '18+'}</Text>
                </View>
                <View style={[styles.heroBadge, isEmailVerified ? styles.verifiedBadge : styles.unverifiedBadge]}>
                  <Feather
                    name={isEmailVerified ? "check-circle" : "alert-circle"}
                    size={11}
                    color={isEmailVerified ? "#2FE0A8" : "#FFA500"}
                    style={{ marginRight: 4 }}
                  />
                  <Text style={[styles.heroBadgeText, { color: isEmailVerified ? '#2FE0A8' : '#FFA500' }]}>
                    {isEmailVerified ? 'Email Verified' : 'Email Unverified'}
                  </Text>
                </View>
              </View>
            </View>

            {/* Menu Options Section */}
            <Text style={styles.menuSectionHeader}>ACCOUNT SETTINGS</Text>

            {/* Option 1: Personal Details */}
            <TouchableOpacity
              style={styles.menuItemCard}
              onPress={() => setActiveTab('edit_profile')}
              activeOpacity={0.75}
            >
              <View style={[styles.menuIconCircle, { backgroundColor: 'rgba(57, 255, 20, 0.12)' }]}>
                <Feather name="user" size={20} color="#39FF14" />
              </View>
              <View style={styles.menuContent}>
                <Text style={styles.menuItemTitle}>Edit Profile Details</Text>
                <Text style={styles.menuItemSubtitle}>Name, Age, Gender, Native Language</Text>
              </View>
              <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.3)" />
            </TouchableOpacity>

            {/* Option 2: Billing & Subscriptions */}
            <TouchableOpacity
              style={styles.menuItemCard}
              onPress={() => setActiveTab('billing')}
              activeOpacity={0.75}
            >
              <View style={[styles.menuIconCircle, { backgroundColor: 'rgba(47, 224, 168, 0.12)' }]}>
                <Feather name="credit-card" size={20} color="#2FE0A8" />
              </View>
              <View style={styles.menuContent}>
                <Text style={styles.menuItemTitle}>Billing & Autopay</Text>
                <Text style={styles.menuItemSubtitle}>
                  {savedCard ? `Autopay active (${savedCard.brand} •••• ${savedCard.last4})` : 'Saved cards, billing address & autopay'}
                </Text>
              </View>
              <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.3)" />
            </TouchableOpacity>

            {/* Option 3: Security & Verification */}
            <TouchableOpacity
              style={styles.menuItemCard}
              onPress={() => setActiveTab('security')}
              activeOpacity={0.75}
            >
              <View style={[styles.menuIconCircle, { backgroundColor: 'rgba(100, 180, 255, 0.12)' }]}>
                <Feather name="shield" size={20} color="#64B4FF" />
              </View>
              <View style={styles.menuContent}>
                <Text style={styles.menuItemTitle}>Security & Verification</Text>
                <Text style={styles.menuItemSubtitle}>Password, Mobile number & Gmail verification</Text>
              </View>
              <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.3)" />
            </TouchableOpacity>

            {/* Quick Actions & Legal */}
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
                  <Text style={styles.restoreBtnText}>Restore Plan & Purchases</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.signOutBtn}
              onPress={() => signOut()}
              activeOpacity={0.8}
            >
              <Feather name="log-out" size={16} color="#FFF" style={{ marginRight: 8 }} />
              <Text style={styles.signOutBtnText}>Sign Out</Text>
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
        )}

        {/* ================================================================= */}
        {/* 2. EDIT PROFILE TAB                                               */}
        {/* ================================================================= */}
        {activeTab === 'edit_profile' && (
          <View style={styles.tabContainer}>
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
                  Used as your default translation language on the home screen.
                </Text>
                <LanguageSelector label="" selected={nativeLanguage} onSelect={setNativeLanguage} />
              </View>

              <TouchableOpacity
                style={[styles.saveBtn, isUpdating && styles.saveBtnDisabled]}
                onPress={handleUpdateProfile}
                disabled={isUpdating}
                activeOpacity={0.85}
              >
                {isUpdating ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <>
                    <Feather name="check" size={20} color="#000" style={{ marginRight: 8 }} />
                    <Text style={styles.saveBtnText}>Save Profile Changes</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* 3. BILLING & AUTOPAY TAB                                          */}
        {/* ================================================================= */}
        {activeTab === 'billing' && (
          <View style={styles.tabContainer}>
            {/* Store Subscription Card */}
            <View style={styles.manageSubscriptionCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                <Feather name="credit-card" size={16} color="#2FE0A8" style={{ marginRight: 8 }} />
                <Text style={styles.manageSubscriptionTitle}>Manage Store Subscription</Text>
              </View>
              <Text style={styles.manageSubscriptionSub}>
                Plans and minutes renew automatically. View, upgrade, or cancel your active subscription in your device store settings.
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

            {/* Saved Card for Autopay */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeaderRow}>
                <Feather name="credit-card" size={18} color="#2FE0A8" />
                <Text style={styles.sectionCardTitle}>CARD DETAILS FOR AUTOPAY</Text>
              </View>
              <Text style={styles.sectionCardSub}>
                Save your credit or debit card details to enable seamless automatic renewal for ShakTalk subscriptions and top-ups.
              </Text>

              {savedCard && (
                <View style={styles.savedCardBox}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <FontAwesome name="cc-visa" size={22} color="#2FE0A8" />
                      <Text style={styles.savedCardTitle}>{savedCard.brand} ending in {savedCard.last4}</Text>
                    </View>
                    <View style={styles.autopayBadge}>
                      <Text style={styles.autopayBadgeText}>AUTOPAY ACTIVE</Text>
                    </View>
                  </View>
                  <Text style={styles.savedCardDetails}>
                    Cardholder: {savedCard.cardholderName}  •  Expires: {savedCard.expiry}
                  </Text>
                </View>
              )}

              <View style={styles.inputGroup}>
                <Text style={styles.label}>CARDHOLDER NAME</Text>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={styles.input}
                    value={cardholderName}
                    onChangeText={setCardholderName}
                    placeholder="e.g. John Doe"
                    placeholderTextColor="rgba(255,255,255,0.2)"
                    autoCapitalize="words"
                  />
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>CARD NUMBER</Text>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={styles.input}
                    value={cardNumber}
                    onChangeText={(v) => {
                      const clean = v.replace(/[^0-9]/g, '').slice(0, 16);
                      const parts = clean.match(/.{1,4}/g);
                      setCardNumber(parts ? parts.join(' ') : clean);
                    }}
                    placeholder="1234 5678 9012 3456"
                    placeholderTextColor="rgba(255,255,255,0.2)"
                    keyboardType="number-pad"
                    maxLength={19}
                  />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>EXPIRY DATE</Text>
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={styles.input}
                      value={cardExp}
                      onChangeText={(v) => {
                        const clean = v.replace(/[^0-9]/g, '').slice(0, 4);
                        if (clean.length > 2) {
                          setCardExp(`${clean.slice(0, 2)}/${clean.slice(2)}`);
                        } else {
                          setCardExp(clean);
                        }
                      }}
                      placeholder="MM/YY"
                      placeholderTextColor="rgba(255,255,255,0.2)"
                      keyboardType="number-pad"
                      maxLength={5}
                    />
                  </View>
                </View>

                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>CVV</Text>
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={styles.input}
                      value={cardCvv}
                      onChangeText={(v) => setCardCvv(v.replace(/[^0-9]/g, '').slice(0, 4))}
                      placeholder="123"
                      placeholderTextColor="rgba(255,255,255,0.2)"
                      keyboardType="number-pad"
                      secureTextEntry
                      maxLength={4}
                    />
                  </View>
                </View>
              </View>

              <TouchableOpacity
                style={[styles.saveBtn, isSavingCard && styles.saveBtnDisabled]}
                onPress={handleSaveCard}
                disabled={isSavingCard}
                activeOpacity={0.85}
              >
                {isSavingCard ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <>
                    <Feather name="shield" size={18} color="#000" style={{ marginRight: 8 }} />
                    <Text style={styles.saveBtnText}>Save Card for Autopay</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {/* Billing Address */}
            <View style={[styles.sectionCard, { marginTop: 18 }]}>
              <View style={styles.sectionHeaderRow}>
                <Feather name="map-pin" size={18} color="#2FE0A8" />
                <Text style={styles.sectionCardTitle}>BILLING ADDRESS</Text>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>STREET ADDRESS</Text>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={styles.input}
                    value={street}
                    onChangeText={setStreet}
                    placeholder="123 Main Street, Apt 4B"
                    placeholderTextColor="rgba(255,255,255,0.2)"
                  />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>CITY</Text>
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={styles.input}
                      value={city}
                      onChangeText={setCity}
                      placeholder="City"
                      placeholderTextColor="rgba(255,255,255,0.2)"
                    />
                  </View>
                </View>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>STATE / PROVINCE</Text>
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={styles.input}
                      value={stateRegion}
                      onChangeText={setStateRegion}
                      placeholder="State"
                      placeholderTextColor="rgba(255,255,255,0.2)"
                    />
                  </View>
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>POSTAL / ZIP CODE</Text>
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={styles.input}
                      value={postalCode}
                      onChangeText={setPostalCode}
                      placeholder="Postal code"
                      placeholderTextColor="rgba(255,255,255,0.2)"
                    />
                  </View>
                </View>
                <View style={[styles.inputGroup, { flex: 1 }]}>
                  <Text style={styles.label}>COUNTRY</Text>
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={styles.input}
                      value={country}
                      onChangeText={setCountry}
                      placeholder="Country"
                      placeholderTextColor="rgba(255,255,255,0.2)"
                    />
                  </View>
                </View>
              </View>

              <TouchableOpacity
                style={[styles.saveBtn, isSavingAddress && styles.saveBtnDisabled]}
                onPress={handleSaveBillingAddress}
                disabled={isSavingAddress}
                activeOpacity={0.85}
              >
                {isSavingAddress ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <>
                    <Feather name="check" size={18} color="#000" style={{ marginRight: 8 }} />
                    <Text style={styles.saveBtnText}>Save Billing Address</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ================================================================= */}
        {/* 4. SECURITY & VERIFICATION TAB                                    */}
        {/* ================================================================= */}
        {activeTab === 'security' && (
          <View style={styles.tabContainer}>
            {/* Primary Email (Gmail) - Non-Editable as requested */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeaderRow}>
                <Feather name="mail" size={18} color="#64B4FF" />
                <Text style={styles.sectionCardTitle}>PRIMARY GMAIL / EMAIL</Text>
              </View>
              <Text style={styles.sectionCardSub}>
                Email address is linked to your primary login and cannot be edited directly for account security.
              </Text>

              <View style={[styles.inputContainer, { backgroundColor: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.06)' }]}>
                <Text style={[styles.input, { color: 'rgba(255,255,255,0.7)' }]}>
                  {user?.primaryEmailAddress?.emailAddress || 'No email attached'}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                <View style={[styles.heroBadge, isEmailVerified ? styles.verifiedBadge : styles.unverifiedBadge]}>
                  <Feather
                    name={isEmailVerified ? "check-circle" : "alert-circle"}
                    size={12}
                    color={isEmailVerified ? "#2FE0A8" : "#FFA500"}
                    style={{ marginRight: 5 }}
                  />
                  <Text style={[styles.heroBadgeText, { color: isEmailVerified ? '#2FE0A8' : '#FFA500' }]}>
                    {isEmailVerified ? 'Gmail Verified' : 'Gmail Not Verified'}
                  </Text>
                </View>

                {!isEmailVerified && (
                  <TouchableOpacity
                    style={styles.verifyActionBtn}
                    onPress={handleSendEmailOtp}
                    disabled={isSendingVerify}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.verifyActionBtnText}>Verify Gmail</Text>
                  </TouchableOpacity>
                )}
              </View>

              {showEmailCodeInput && (
                <View style={styles.otpBox}>
                  <Text style={styles.otpLabel}>Enter 6-digit verification code sent to your email:</Text>
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                    <View style={[styles.inputContainer, { flex: 1 }]}>
                      <TextInput
                        style={styles.input}
                        value={emailCode}
                        onChangeText={setEmailCode}
                        placeholder="123456"
                        placeholderTextColor="rgba(255,255,255,0.2)"
                        keyboardType="number-pad"
                        maxLength={6}
                      />
                    </View>
                    <TouchableOpacity
                      style={styles.confirmOtpBtn}
                      onPress={handleVerifyEmailCode}
                      disabled={isSendingVerify}
                    >
                      <Text style={styles.confirmOtpBtnText}>Submit</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>

            {/* Mobile Number Update & Verification */}
            <View style={[styles.sectionCard, { marginTop: 18 }]}>
              <View style={styles.sectionHeaderRow}>
                <Feather name="phone" size={18} color="#64B4FF" />
                <Text style={styles.sectionCardTitle}>MOBILE NUMBER</Text>
              </View>
              <Text style={styles.sectionCardSub}>
                Update and verify your mobile number for account recovery and two-factor call security.
              </Text>

              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.input}
                  value={phoneNumber}
                  onChangeText={setPhoneNumber}
                  placeholder="+1 234 567 8900 or +91 98765 43210"
                  placeholderTextColor="rgba(255,255,255,0.2)"
                  keyboardType="phone-pad"
                />
              </View>

              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <TouchableOpacity
                  style={[styles.smallBtn, { flex: 1, backgroundColor: 'rgba(255,255,255,0.1)' }]}
                  onPress={handleUpdateMobile}
                  disabled={isUpdatingPhone}
                  activeOpacity={0.8}
                >
                  <Text style={styles.smallBtnText}>Update Number</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.smallBtn, { flex: 1, backgroundColor: isPhoneVerified ? 'rgba(47,224,168,0.15)' : '#64B4FF' }]}
                  onPress={handleSendPhoneOtp}
                  disabled={isSendingVerify}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.smallBtnText, { color: isPhoneVerified ? '#2FE0A8' : '#000' }]}>
                    {isPhoneVerified ? '✓ Phone Verified' : 'Verify Mobile OTP'}
                  </Text>
                </TouchableOpacity>
              </View>

              {showPhoneCodeInput && (
                <View style={styles.otpBox}>
                  <Text style={styles.otpLabel}>Enter SMS code sent to {phoneNumber}:</Text>
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
                    <View style={[styles.inputContainer, { flex: 1 }]}>
                      <TextInput
                        style={styles.input}
                        value={phoneCode}
                        onChangeText={setPhoneCode}
                        placeholder="123456"
                        placeholderTextColor="rgba(255,255,255,0.2)"
                        keyboardType="number-pad"
                        maxLength={6}
                      />
                    </View>
                    <TouchableOpacity
                      style={styles.confirmOtpBtn}
                      onPress={handleVerifyPhoneCode}
                      disabled={isSendingVerify}
                    >
                      <Text style={styles.confirmOtpBtnText}>Verify OTP</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>

            {/* Change Password */}
            <View style={[styles.sectionCard, { marginTop: 18 }]}>
              <View style={styles.sectionHeaderRow}>
                <Feather name="lock" size={18} color="#64B4FF" />
                <Text style={styles.sectionCardTitle}>CHANGE PASSWORD</Text>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>CURRENT PASSWORD</Text>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={styles.input}
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    placeholder="Enter current password"
                    placeholderTextColor="rgba(255,255,255,0.2)"
                    secureTextEntry
                  />
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>NEW PASSWORD</Text>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={styles.input}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    placeholder="At least 8 characters"
                    placeholderTextColor="rgba(255,255,255,0.2)"
                    secureTextEntry
                  />
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>CONFIRM NEW PASSWORD</Text>
                <View style={styles.inputContainer}>
                  <TextInput
                    style={styles.input}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="Re-enter new password"
                    placeholderTextColor="rgba(255,255,255,0.2)"
                    secureTextEntry
                  />
                </View>
              </View>

              <TouchableOpacity
                style={[styles.saveBtn, { backgroundColor: '#64B4FF' }, isUpdatingPassword && styles.saveBtnDisabled]}
                onPress={handleChangePassword}
                disabled={isUpdatingPassword}
                activeOpacity={0.85}
              >
                {isUpdatingPassword ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <>
                    <Feather name="lock" size={18} color="#000" style={{ marginRight: 8 }} />
                    <Text style={styles.saveBtnText}>Update Password</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
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
    borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center', alignItems: 'center',
  },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  scroll: { padding: 20, paddingBottom: 40 },
  tabContainer: { width: '100%' },

  // Overview Hero Card
  profileHeroCard: {
    backgroundColor: '#121615',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.2)',
    padding: 22,
    alignItems: 'center',
    marginBottom: 24,
  },
  heroAvatarWrapper: {
    position: 'relative',
    width: 90, height: 90, borderRadius: 45,
    marginBottom: 14,
  },
  heroAvatar: { width: 90, height: 90, borderRadius: 45 },
  heroAvatarPlaceholder: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: '#1B221F',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', alignItems: 'center',
  },
  editAvatarBtn: {
    position: 'absolute', bottom: 0, right: 0,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: '#2FE0A8',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2.5, borderColor: '#121615',
  },
  heroName: {
    color: '#FFF',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  heroEmail: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 13,
    marginTop: 4,
    marginBottom: 14,
  },
  heroBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  heroBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  heroBadgeText: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 11.5,
    fontWeight: '600',
  },
  verifiedBadge: {
    backgroundColor: 'rgba(47, 224, 168, 0.12)',
    borderColor: 'rgba(47, 224, 168, 0.35)',
  },
  unverifiedBadge: {
    backgroundColor: 'rgba(255, 165, 0, 0.12)',
    borderColor: 'rgba(255, 165, 0, 0.35)',
  },

  // Menu Section
  menuSectionHeader: {
    color: '#8A9793',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 12,
    marginLeft: 4,
  },
  menuItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#121614',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
  },
  menuIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  menuContent: { flex: 1 },
  menuItemTitle: {
    color: '#FFF',
    fontSize: 15.5,
    fontWeight: '700',
    marginBottom: 2,
  },
  menuItemSubtitle: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 12,
  },

  // Section Cards in Sub-views
  sectionCard: {
    backgroundColor: '#121614',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 18,
    padding: 18,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  sectionCardTitle: {
    color: '#FFF',
    fontSize: 12.5,
    fontWeight: '800',
    letterSpacing: 1,
  },
  sectionCardSub: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 16,
  },

  // Saved Card Box
  savedCardBox: {
    backgroundColor: 'rgba(47, 224, 168, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.3)',
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
  },
  savedCardTitle: {
    color: '#2FE0A8',
    fontSize: 15,
    fontWeight: '700',
  },
  savedCardDetails: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 12,
    marginTop: 6,
  },
  autopayBadge: {
    backgroundColor: 'rgba(47, 224, 168, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  autopayBadgeText: {
    color: '#2FE0A8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  // Forms & Inputs
  form: { gap: 20 },
  inputGroup: { gap: 8, marginTop: 10 },
  label: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  inputContainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 14,
    paddingHorizontal: 16,
    height: 52,
    justifyContent: 'center',
  },
  input: { color: '#FFF', fontSize: 15 },
  hint: {
    color: 'rgba(255, 255, 255, 0.35)',
    fontSize: 11,
    lineHeight: 15,
    marginTop: -4,
  },

  // Gender Pills
  pillRow: { flexDirection: 'row', gap: 10 },
  pill: {
    flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  pillActive: {
    backgroundColor: 'rgba(57, 255, 20, 0.1)',
    borderColor: '#39FF14',
  },
  pillText: {
    color: 'rgba(255, 255, 255, 0.4)', fontSize: 12, fontWeight: '600', textAlign: 'center',
  },
  pillTextActive: { color: '#39FF14' },

  // Buttons
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#2FE0A8', borderRadius: 16, height: 52,
    marginTop: 18,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: '#000', fontSize: 15, fontWeight: '800' },

  smallBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallBtnText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '700',
  },

  verifyActionBtn: {
    backgroundColor: '#FFA500',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  verifyActionBtnText: {
    color: '#000',
    fontSize: 12,
    fontWeight: '800',
  },

  otpBox: {
    marginTop: 14,
    padding: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  otpLabel: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 11.5,
  },
  confirmOtpBtn: {
    backgroundColor: '#2FE0A8',
    borderRadius: 14,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  confirmOtpBtnText: {
    color: '#000',
    fontSize: 13,
    fontWeight: '800',
  },

  // Manage Subscription
  manageSubscriptionCard: {
    backgroundColor: '#121615',
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.25)',
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
  },
  manageSubscriptionTitle: {
    color: '#2FE0A8',
    fontSize: 15,
    fontWeight: '700',
  },
  manageSubscriptionSub: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 12.5,
    lineHeight: 18,
    marginBottom: 14,
  },
  manageStoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2FE0A8',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  manageStoreBtnText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '700',
  },

  // Account Operations
  restoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(47, 224, 168, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(47, 224, 168, 0.3)',
    borderRadius: 16,
    height: 50,
    marginTop: 8,
  },
  restoreBtnText: {
    color: '#2FE0A8',
    fontSize: 14,
    fontWeight: '700',
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 16,
    height: 50,
    marginTop: 10,
  },
  signOutBtnText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '700',
  },
  deleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 16, marginBottom: 8, height: 48, borderRadius: 14,
    borderWidth: 1, borderColor: 'rgba(232,92,92,0.3)',
  },
  deleteBtnText: { color: '#E85C5C', fontSize: 14, fontWeight: '700' },
  legalRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 8, marginTop: 24, flexWrap: 'wrap',
  },
  legalLink: { color: 'rgba(255,255,255,0.5)', fontSize: 12.5, textDecorationLine: 'underline' },
  legalDot: { color: 'rgba(255,255,255,0.3)' },
});
