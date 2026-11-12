import { Alert } from 'react-native';

export const errorMessage = (error: unknown, fallback = 'Try again.'): string =>
  error instanceof Error && error.message ? error.message : fallback;

/** `promise.catch(showError('Couldn’t delete'))` */
export const showError = (title: string, fallback?: string) => (error: unknown) => Alert.alert(title, errorMessage(error, fallback));
