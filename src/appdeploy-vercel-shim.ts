type User = { userId: string; email?: string; name?: string; picture?: string; scope: string };

const unavailable = () =>
  Promise.reject(new Error('This GitHub/Vercel preview does not include the AppDeploy backend. Use the AppDeploy deployment for live authentication and account APIs.'));

export const auth = {
  signIn: unavailable as (options?: { scope?: string }) => Promise<{ user: User; accessToken: string; expiresIn: number }>,
  getUser: async (): Promise<User | null> => null,
  getAccessToken: async (): Promise<string | null> => null,
  signOut: async (): Promise<void> => {},
  isSignedIn: (): boolean => false,
};

export const api = {
  get: unavailable,
  post: unavailable,
  put: unavailable,
  delete: unavailable,
};
