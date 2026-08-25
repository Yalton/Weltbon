import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireAdmin, type AuthVariables } from '../middleware/auth.js';
import { disableUser, enableUser, LastAdminError, listAdminAuditEvents, listAdminUsers, purgeUser, PurgeConfirmationError, setAdminStatus } from '../services/admin-users.js';

type AppEnv = { Variables: AuthVariables };
export const adminUserRoutes = new OpenAPIHono<AppEnv>()
  .get('/users', requireAdmin, async (c) => c.json(await listAdminUsers(), 200))
  .get('/audit-log', requireAdmin, async (c) => c.json(await listAdminAuditEvents(), 200))
  .patch('/users/:id/admin', requireAdmin, async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const body = z.object({ isAdmin: z.boolean() }).parse(await c.req.json());
    try {
      const user = await setAdminStatus(c.var.userId, id, body.isAdmin);
      if (!user) throw new HTTPException(404, { message: 'User not found' });
      return c.json(user, 200);
    } catch (error) {
      if (error instanceof LastAdminError) return c.json({ error: 'At least one active administrator is required', code: 'last_admin_required' }, 409);
      throw error;
    }
  })
  .post('/users/:id/disable', requireAdmin, async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ reason: z.string().trim().max(500).optional() }).parse(body);
    try {
      const user = await disableUser(c.var.userId, id, parsed.reason);
      if (!user) throw new HTTPException(404, { message: 'User not found' });
      return c.json(user, 200);
    } catch (error) {
      if (error instanceof LastAdminError) return c.json({ error: 'At least one active administrator is required', code: 'last_admin_required' }, 409);
      throw error;
    }
  })
  .post('/users/:id/enable', requireAdmin, async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const user = await enableUser(c.var.userId, id);
    if (!user) throw new HTTPException(404, { message: 'User not found' });
    return c.json(user, 200);
  })
  .delete('/users/:id', requireAdmin, async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const body = z.object({ confirmEmail: z.string().email() }).parse(await c.req.json());
    try {
      const user = await purgeUser(c.var.userId, id, body.confirmEmail);
      if (!user) throw new HTTPException(404, { message: 'User not found' });
      return c.json(user, 200);
    } catch (error) {
      if (error instanceof PurgeConfirmationError) return c.json({ error: 'Confirmation email must match the target user', code: 'confirmation_mismatch' }, 400);
      if (error instanceof LastAdminError) return c.json({ error: 'At least one active administrator is required', code: 'last_admin_required' }, 409);
      throw error;
    }
  });
