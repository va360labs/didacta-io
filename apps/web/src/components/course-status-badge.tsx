import { Badge } from '@/components/ui/badge';
import type { CourseStatus } from '@/lib/courses';

const LABELS: Record<CourseStatus, string> = {
  DRAFT: 'Borrador',
  PUBLISHED: 'Publicado',
  ARCHIVED: 'Archivado',
};

export function CourseStatusBadge({ status }: { status: CourseStatus }) {
  if (status === 'PUBLISHED') return <Badge variant="success">{LABELS[status]}</Badge>;
  if (status === 'ARCHIVED') return <Badge variant="muted">{LABELS[status]}</Badge>;
  return <Badge variant="warning">{LABELS[status]}</Badge>;
}
