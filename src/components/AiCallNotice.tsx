import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { colors } from '../theme';

/**
 * Shown at the start of every call (it covers the ~1 s while the translator
 * connects). The call keeps connecting underneath; tapping "I understand"
 * closes it. A short permanent label (AiTranslationLabel) stays on screen.
 */
export function AiCallNotice({ onClose }: { onClose: () => void }) {
  return (
    <View style={styles.backdrop} accessibilityViewIsModal>
      <View style={styles.card}>
        <View style={styles.head}>
          <Feather name="info" size={18} color={colors.signal} />
          <Text style={styles.title}>AI live translation</Text>
        </View>
        <Text style={styles.body}>
          This call is translated by AI in real time. Translations are usually accurate, but they can contain mistakes, miss words or change the meaning.
        </Text>
        <View style={styles.list}>
          <Text style={styles.item}>• Confirm important details (amounts, dates, addresses) before acting on them.</Text>
          <Text style={styles.item}>• A translation is not an exact or verified record of what the other person said. Do not use it as proof of their words, identity or agreement.</Text>
          <Text style={styles.item}>• Not suitable for emergencies or medical or legal advice.</Text>
        </View>
        <TouchableOpacity style={styles.btn} onPress={onClose} accessibilityRole="button">
          <Text style={styles.btnText}>I understand</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** Small permanent reminder under the call header. */
export function AiTranslationLabel() {
  return (
    <View style={styles.label}>
      <Feather name="cpu" size={11} color={colors.muted} />
      <Text style={styles.labelText}>AI translation · may contain errors</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50,
    backgroundColor: 'rgba(5,7,6,0.72)', alignItems: 'center', justifyContent: 'center', padding: 20,
  },
  card: {
    width: '100%', maxWidth: 420, backgroundColor: colors.surface, borderRadius: 22, padding: 22,
    borderWidth: 1, borderColor: 'rgba(47,224,168,0.3)',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  title: { color: colors.warm, fontSize: 18, fontWeight: '800' },
  body: { color: colors.warm, fontSize: 14.5, lineHeight: 21 },
  list: { marginTop: 12, gap: 8 },
  item: { color: colors.muted, fontSize: 13.5, lineHeight: 19 },
  btn: { marginTop: 18, height: 50, borderRadius: 14, backgroundColor: colors.signal, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: colors.signalOnDark, fontWeight: '800', fontSize: 15.5 },
  label: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 4 },
  labelText: { color: colors.muted, fontSize: 11.5 },
});
