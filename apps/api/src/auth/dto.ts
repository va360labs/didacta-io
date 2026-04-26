import { z } from 'zod';

export const signupSchema = z.object({
  tenantSlug: z.string().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(12).max(128),
  name: z.string().min(1).max(120).optional(),
});
export type SignupDto = z.infer<typeof signupSchema>;

export const signinSchema = z.object({
  tenantSlug: z.string().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(1).max(128),
});
export type SigninDto = z.infer<typeof signinSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshDto = z.infer<typeof refreshSchema>;

export const forgotPasswordSchema = z.object({
  tenantSlug: z.string().min(1).max(64),
  email: z.string().email(),
});
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(40).max(200),
  newPassword: z.string().min(12).max(128),
});
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
