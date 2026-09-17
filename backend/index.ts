import { router, json, error, requireAuth } from '@appdeploy/sdk';
import { db } from '@appdeploy/sdk';

interface AccountProfile {
  email?: string;
  name?: string;
  phone?: string;
  country?: string;
  identityStatus: 'pending' | 'started' | 'verified';
  createdAt: string;
}

export const handler = router({
  'GET /api/account': [
    requireAuth(),
    async (ctx) => {
      const result = await db.list<AccountProfile>(`account:${ctx.user!.userId}`, { limit: 1 });
      const profile = result.items[0];
      return json({
        user: ctx.user,
        profile: profile ?? null,
      });
    },
  ],
  'POST /api/account/onboarding': [
    requireAuth(),
    async (ctx) => {
      const body = (ctx.body ?? {}) as {
        phone?: string;
        country?: string;
        identityStatus?: AccountProfile['identityStatus'];
      };
      const table = `account:${ctx.user!.userId}`;
      const existing = await db.list<AccountProfile>(table, { limit: 1 });
      const now = new Date().toISOString();
      const profile: AccountProfile = {
        email: ctx.user!.email,
        name: ctx.user!.name,
        phone: body.phone || undefined,
        country: body.country || undefined,
        identityStatus: body.identityStatus ?? 'pending',
        createdAt: existing.items[0]?.createdAt ?? now,
      };

      if (existing.items[0]) {
        const ok = await db.update(table, [{ id: existing.items[0].id, record: profile }]);
        if (!ok[0]) return error('Could not save account profile', 500);
        return json({ saved: true, profile });
      }

      const [id] = await db.add(table, [profile]);
      if (!id) return error('Could not create account profile', 500);
      return json({ saved: true, id, profile });
    },
  ],
});
