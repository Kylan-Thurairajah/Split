import '../src/styles.css';
import { Stack } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/auth';
import { ProfileSetup } from '../src/account-ui';
import { ThemeProvider } from '../src/ui';

const queryClient = new QueryClient();

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <Stack screenOptions={{ headerShown: false, animation: 'none' }} />
          <ProfileSetup />
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
