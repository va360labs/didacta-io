import { describe, expect, it, vi } from 'vitest';
import { AdminStatsService } from '../src/admin/admin-stats.service';

function setup(
  opts: {
    activeUsers?: number;
    coursesPublished?: number;
    enrollmentsActive?: number;
    enrollmentsCompleted?: number;
    certificatesIssued?: number;
  } = {},
) {
  const counts = {
    user: opts.activeUsers ?? 0,
    course: opts.coursesPublished ?? 0,
    total: (opts.enrollmentsActive ?? 0) + (opts.enrollmentsCompleted ?? 0),
    completed: opts.enrollmentsCompleted ?? 0,
    cert: opts.certificatesIssued ?? 0,
  };

  const userCount = vi.fn(async () => counts.user);
  const courseCount = vi.fn(async () => counts.course);
  const enrollmentCount = vi.fn(async ({ where }: any) => {
    if (where.status === 'COMPLETED') return counts.completed;
    return counts.total;
  });
  const certCount = vi.fn(async () => counts.cert);

  const prisma = {
    user: { count: userCount },
    modCoursesCourse: { count: courseCount },
    modLearningEnrollment: { count: enrollmentCount },
    modCertificatesIssued: { count: certCount },
  } as never;

  return {
    service: new AdminStatsService(prisma),
    enrollmentCount,
    certCount,
  };
}

describe('AdminStatsService.getStats', () => {
  it('range=all no aplica filtro de fecha en queries temporales', async () => {
    const { service, enrollmentCount, certCount } = setup({
      enrollmentsActive: 10,
      enrollmentsCompleted: 5,
      certificatesIssued: 3,
    });
    await service.getStats('t1', 'all');
    const calls = enrollmentCount.mock.calls.map((c) => c[0].where);
    expect(calls.every((w: any) => !w.createdAt)).toBe(true);
    expect(certCount.mock.calls[0]?.[0].where.issuedAt).toBeUndefined();
  });

  it('range=30d aplica createdAt gte ~30 días atrás', async () => {
    const { service, enrollmentCount } = setup();
    const before = Date.now();
    await service.getStats('t1', '30d');
    const where = (enrollmentCount.mock.calls[0]?.[0] as any).where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    const diff = before - (where.createdAt.gte as Date).getTime();
    // ~30 days ± 1s tolerance
    expect(diff).toBeGreaterThan(30 * 24 * 60 * 60 * 1000 - 2000);
    expect(diff).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 2000);
  });

  it('calcula completionRate como completed/total redondeado', async () => {
    const { service } = setup({ enrollmentsActive: 7, enrollmentsCompleted: 3 });
    const stats = await service.getStats('t1', 'all');
    expect(stats.totalEnrollments).toBe(10);
    expect(stats.completionRate).toBe(30);
  });

  it('completionRate = 0 cuando no hay enrollments (evita división por cero)', async () => {
    const { service } = setup();
    const stats = await service.getStats('t1', '7d');
    expect(stats.completionRate).toBe(0);
  });

  it('devuelve los counts crudos en cada campo', async () => {
    const { service } = setup({
      activeUsers: 100,
      coursesPublished: 12,
      enrollmentsActive: 80,
      enrollmentsCompleted: 20,
      certificatesIssued: 18,
    });
    const stats = await service.getStats('t1', 'all');
    expect(stats).toMatchObject({
      range: 'all',
      activeUsers: 100,
      coursesPublished: 12,
      totalEnrollments: 100,
      certificatesIssued: 18,
      completionRate: 20,
    });
  });
});
