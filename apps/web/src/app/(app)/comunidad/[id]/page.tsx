'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { PostDetailView } from '@/components/post-detail-view';

export default function PostDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  if (!params?.id) return null;

  return (
    <section className="space-y-6">
      <Link
        href="/comunidad"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-text"
      >
        <span aria-hidden="true">←</span>
        Volver a la comunidad
      </Link>

      <PostDetailView postId={params.id} onClose={() => router.push('/comunidad')} />
    </section>
  );
}
