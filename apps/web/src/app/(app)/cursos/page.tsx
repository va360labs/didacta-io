import { Suspense } from 'react';
import { CatalogView } from './catalog-view';

export default function CatalogPage() {
  return (
    <Suspense
      fallback={
        <section className="space-y-8">
          <div className="space-y-3">
            <div className="skeleton h-10 w-72 max-w-full" />
            <div className="skeleton h-5 w-96 max-w-full" />
          </div>
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} className="skeleton h-64 w-full" />
            ))}
          </div>
        </section>
      }
    >
      <CatalogView />
    </Suspense>
  );
}
