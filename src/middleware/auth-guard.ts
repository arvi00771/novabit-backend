/**
 * NovaBit Exchange — Authorization & Access Control
 *
 * Middleware for role-based access control (RBAC).
 * Guards routes based on user role.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../middleware/error-handler.js';

type Role = 'USER' | 'VIP' | 'ADMIN' | 'SUPER_ADMIN';

const roleHierarchy: Record<Role, number> = {
  USER: 1,
  VIP: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4,
};

/**
 * Creates a preHandler that requires a minimum role level.
 * Use after the `authenticate` preHandler.
 */
export function requireRole(minRole: Role) {
  return async function (request: FastifyRequest, _reply: FastifyReply) {
    const userRole = (request.user?.role ?? 'USER') as Role;
    const userLevel = roleHierarchy[userRole] ?? 0;
    const requiredLevel = roleHierarchy[minRole];

    if (userLevel < requiredLevel) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
    }
  };
}

/**
 * Creates a preHandler that requires the user owns the resource
 * OR has admin-level access.
 */
export function requireOwnershipOrAdmin(getTargetUserId: (request: FastifyRequest) => string) {
  return async function (request: FastifyRequest, _reply: FastifyReply) {
    const userRole = (request.user?.role ?? 'USER') as Role;
    const userLevel = roleHierarchy[userRole] ?? 0;

    if (userLevel >= roleHierarchy.ADMIN) return; // admins can access all

    const targetUserId = getTargetUserId(request);
    if (request.user.id !== targetUserId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not own this resource');
    }
  };
}