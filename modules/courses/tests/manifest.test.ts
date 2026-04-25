import { describe, expect, it } from 'vitest';
import { manifest } from '../src/manifest';

describe('mod.courses manifest', () => {
  it('respeta el contrato del core', () => {
    expect(manifest.name).toBe('mod.courses');
    expect(manifest.tablePrefix).toBe('mod_courses_');
    expect(manifest.apiNamespace).toBe('/modules/courses');
    expect(manifest.eventsEmitted).toContain('courses.course.published');
    expect(manifest.hooksExposed.map((h) => h.name)).toContain('courses.publish.validate');
  });
});
