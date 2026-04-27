import { describe, expect, it } from 'vitest';
import { parseScormManifest, ScormManifestError } from '../src/scorm-parser';

const SCORM_12_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-DIDACTA" version="1.0"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Curso de prueba</title>
      <item identifier="ITEM-1" identifierref="RES-1">
        <title>Lección 1</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
      <file href="style.css"/>
    </resource>
  </resources>
</manifest>`;

const SCORM_2004_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-2004" version="1.0">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>CAM 1.3</schemaversion>
  </metadata>
  <organizations default="ORG-A">
    <organization identifier="ORG-A">
      <title>Curso 2004</title>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-A" type="webcontent" scormType="sco" href="story.html">
      <file href="story.html"/>
    </resource>
  </resources>
</manifest>`;

describe('parseScormManifest', () => {
  it('parsea SCORM 1.2 con entryPath correcto', () => {
    const r = parseScormManifest(SCORM_12_MANIFEST);
    expect(r.version).toBe('1.2');
    expect(r.entryPath).toBe('index.html');
    expect(r.organizations).toEqual(['ORG-1']);
  });

  it('parsea SCORM 2004 (CAM 1.3) con entryPath', () => {
    const r = parseScormManifest(SCORM_2004_MANIFEST);
    expect(r.version).toBe('2004');
    expect(r.entryPath).toBe('story.html');
    expect(r.organizations).toEqual(['ORG-A']);
  });

  it('lanza INVALID_XML si no hay <manifest>', () => {
    expect(() => parseScormManifest('<root><foo/></root>')).toThrow(ScormManifestError);
  });

  it('lanza NO_RESOURCES si no hay <resources>', () => {
    const xml = `<manifest>
      <metadata><schemaversion>1.2</schemaversion></metadata>
      <organizations><organization identifier="o1"/></organizations>
    </manifest>`;
    expect(() => parseScormManifest(xml)).toThrowError(/NO_RESOURCES|<resources>/);
  });

  it('lanza NO_ENTRY si el resource no tiene href', () => {
    const xml = `<manifest>
      <metadata><schemaversion>1.2</schemaversion></metadata>
      <resources>
        <resource identifier="r" type="webcontent" adlcp:scormtype="sco"/>
      </resources>
    </manifest>`;
    expect(() => parseScormManifest(xml)).toThrowError(/NO_ENTRY|href/);
  });

  it('cae a 1.2 cuando schemaversion es desconocido', () => {
    const xml = `<manifest>
      <metadata><schemaversion>foobar</schemaversion></metadata>
      <resources>
        <resource identifier="r" type="webcontent" href="index.html"/>
      </resources>
    </manifest>`;
    const r = parseScormManifest(xml);
    expect(r.version).toBe('1.2');
    expect(r.entryPath).toBe('index.html');
  });
});
