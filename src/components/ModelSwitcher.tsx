import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { CallEngine, getStoredEngine, setStoredEngine, subscribeEngineChange } from '../utils/enginePreference';

interface ModelSwitcherProps {
  style?: ViewStyle;
}

export function ModelSwitcher({ style }: ModelSwitcherProps) {
  const [engine, setEngine] = useState<CallEngine>('legacy');

  useEffect(() => {
    getStoredEngine().then(setEngine);
    const unsubscribe = subscribeEngineChange(setEngine);
    return unsubscribe;
  }, []);

  const handleSelect = (choice: CallEngine) => {
    setEngine(choice);
    setStoredEngine(choice);
  };

  return (
    <View style={[styles.container, style]}>
      <View style={styles.headerRow}>
        <Feather name="cpu" size={13} color="#2FE0A8" />
        <Text style={styles.headerLabel}>AI TRANSLATION MODEL</Text>
      </View>

      <View style={styles.switchWrapper}>
        {/* Gemini 2.5 Flash Button */}
        <TouchableOpacity
          style={[
            styles.modelBtn,
            engine === 'legacy' ? styles.modelBtnActive : styles.modelBtnInactive,
          ]}
          onPress={() => handleSelect('legacy')}
          activeOpacity={0.8}
        >
          <View style={styles.btnContent}>
            <View style={styles.titleRow}>
              <View style={styles.titleWithIcon}>
                <Feather
                  name="zap"
                  size={13}
                  color={engine === 'legacy' ? '#39FF14' : '#8A9793'}
                  style={{ marginRight: 4 }}
                />
                <Text
                  style={[
                    styles.btnTitle,
                    engine === 'legacy' ? styles.btnTitleActiveLegacy : styles.btnTitleInactive,
                  ]}
                >
                  2.5 Flash
                </Text>
              </View>
              {engine === 'legacy' && (
                <View style={[styles.activeCheck, { backgroundColor: '#39FF14' }]}>
                  <Feather name="check" size={10} color="#000" />
                </View>
              )}
            </View>
            <Text style={styles.btnSubtitle}>Vertex AI • Stable (~$0.06/m)</Text>
          </View>
        </TouchableOpacity>

        {/* Gemini 3.5 Live Button */}
        <TouchableOpacity
          style={[
            styles.modelBtn,
            engine === 'livekit' ? styles.modelBtnActive : styles.modelBtnInactive,
          ]}
          onPress={() => handleSelect('livekit')}
          activeOpacity={0.8}
        >
          <View style={styles.btnContent}>
            <View style={styles.titleRow}>
              <View style={styles.titleWithIcon}>
                <Feather
                  name="activity"
                  size={13}
                  color={engine === 'livekit' ? '#2FE0A8' : '#8A9793'}
                  style={{ marginRight: 4 }}
                />
                <Text
                  style={[
                    styles.btnTitle,
                    engine === 'livekit' ? styles.btnTitleActiveLive : styles.btnTitleInactive,
                  ]}
                >
                  3.5 Live
                </Text>
              </View>
              {engine === 'livekit' && (
                <View style={[styles.activeCheck, { backgroundColor: '#2FE0A8' }]}>
                  <Feather name="check" size={10} color="#000" />
                </View>
              )}
            </View>
            <Text style={styles.btnSubtitle}>LiveKit • Simultaneous (~$0.10/m)</Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#121714',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 6,
  },
  headerLabel: {
    color: '#8A9793',
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  switchWrapper: {
    flexDirection: 'row',
    gap: 8,
  },
  modelBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
  },
  modelBtnActive: {
    backgroundColor: '#182C22',
    borderColor: '#2FE0A8',
  },
  modelBtnInactive: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  btnContent: {
    flexDirection: 'column',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  btnTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  btnTitleActiveLegacy: {
    color: '#39FF14',
  },
  btnTitleActiveLive: {
    color: '#2FE0A8',
  },
  btnTitleInactive: {
    color: '#D1DDD9',
  },
  btnSubtitle: {
    fontSize: 10,
    color: '#7C8985',
    marginTop: 3,
  },
  activeCheck: {
    width: 15,
    height: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
