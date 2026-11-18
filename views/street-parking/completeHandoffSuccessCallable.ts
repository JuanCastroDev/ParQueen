import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';

export async function completeHandoffSuccessCallable(input: {
  spotId: string;
  finderId: string;
}): Promise<{ outcome?: string }> {
  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<typeof input, { outcome?: string }>(functions, 'completeHandoffSuccess');
  const response = await callable(input);
  return response.data;
}
