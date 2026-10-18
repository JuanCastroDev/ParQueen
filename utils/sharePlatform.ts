import { Capacitor } from '@capacitor/core';

export const isAndroidSharePlatform = (): boolean => Capacitor.getPlatform() === 'android';
