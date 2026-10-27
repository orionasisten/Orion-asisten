import { Platform } from 'react-native';

/** Platform & konfigurasi runtime-specific (terpisah dari api/client agar tetap testable di Node). */
export const currentPlatform = (): 'android' | 'ios' => (Platform.OS === 'ios' ? 'ios' : 'android');
export const deviceName = (): string => (Platform.OS === 'ios' ? 'iOS Device' : 'Android Device');
