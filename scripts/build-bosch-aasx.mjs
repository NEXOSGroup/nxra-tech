// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-bosch-aasx.mjs — One-off generator that produces a demo AASX for a
 * Bosch Rexroth ctrlX DRIVE axis (controller + MS2N synchronous servomotor).
 *
 * Structure mirrors the existing Festo AASX (AAS V2 namespace):
 *   - one AssetAdministrationShell
 *   - submodels: Nameplate, TechnicalData, Documentation
 *   - embedded PDFs from C:/Users/ThomasStrigl/Downloads/
 *
 * Usage: node scripts/build-bosch-aasx.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'public', 'aasx', '25_BoschRexroth.aasx');

// ─── Asset identification ──────────────────────────────────────────────
const AAS_ID = 'https://aas.boschrexroth.com/ctrlxdrive/R911410072-MS2N-Demo-0001';
const ASSET_ID = 'https://aas.boschrexroth.com/asset/ctrlxdrive/R911410072-MS2N-Demo-0001';
const ID_SHORT = 'BoschRexroth_ctrlXDRIVE_MS2N_R911410072';

// ─── Source PDFs ───────────────────────────────────────────────────────
const PDF_SOURCES = [
  {
    src: 'C:/Users/ThomasStrigl/Downloads/R911410072_06_DE_ctrlX DRIVE Runtime AXS-V-03RS Funktionen_Anwendungsbeschreibung.pdf',
    zipName: 'R911410072_ctrlXDRIVE_Runtime_AXS-V-03RS_Funktionen_0001.pdf',
    title: 'Anwendungsbeschreibung – ctrlX DRIVE Runtime AXS-V-03RS Funktionen',
  },
  {
    src: 'C:/Users/ThomasStrigl/Downloads/R911347581_08_EN_MS2N Synchronous Servomotors_Operating Instructions.pdf',
    zipName: 'R911347581_MS2N_Synchronous_Servomotors_Operating_Instructions_0002.pdf',
    title: 'Operating Instructions – MS2N Synchronous Servomotors',
  },
  {
    src: 'C:/Users/ThomasStrigl/Downloads/DCTC-30136-002_KOE_N_D0_2021-08-27.pdf',
    zipName: 'DCTC-30136-002_KOE_N_D0_0003.pdf',
    title: 'Konformitätserklärung – DCTC-30136-002',
  },
];

// ─── Nameplate properties (ZVEI-style) ─────────────────────────────────
const NAMEPLATE = [
  ['ManufacturerName',                 'Bosch Rexroth AG'],
  ['ManufacturerProductDesignation',   'ctrlX DRIVE – Servo Drive System'],
  ['CountryCode',                      'DE'],
  ['Street',                           'Bgm.-Dr.-Nebel-Str. 2'],
  ['Zip',                              '97816'],
  ['CityTown',                         'Lohr am Main'],
  ['StateCounty',                      'Bayern'],
  ['ManufacturerProductFamily',        'ctrlX DRIVE / MS2N'],
  ['ProductCountryOfOrigin',           'DE'],
  ['YearOfConstruction',               '2024'],
  ['CEQualificationPresent',           '1'],
];

// ─── Technical data (selected, fits typical MS2N data sheet) ───────────
const TECHNICAL_DATA = [
  ['DriveControllerType',     'ctrlX DRIVE AXS-V-03RS'],
  ['MotorType',               'MS2N synchronous servo motor'],
  ['RatedTorque',             '12.0 Nm'],
  ['StandstillTorque',        '14.5 Nm'],
  ['RatedSpeed',              '3000 1/min'],
  ['MaxSpeed',                '6000 1/min'],
  ['RatedCurrent',            '8.5 A'],
  ['RatedVoltage',            '600 V DC'],
  ['DegreeOfProtection',      'IP65'],
  ['ThermalClass',            '155 (F)'],
  ['CoolingMode',             'Natural convection'],
  ['MotorEncoder',            'Multiturn absolute, 23 bit, Hiperface DSL'],
  ['AmbientTemperature',      '0 ... 40 °C'],
  ['StorageTemperature',      '-20 ... 80 °C'],
  ['RelativeAirHumidity',     '5 - 95 %'],
];

// ─── XML helpers ───────────────────────────────────────────────────────
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function propertyXml(idShort, value) {
  return `        <aas:submodelElement>
          <aas:property>
            <aas:idShort>${xmlEscape(idShort)}</aas:idShort>
            <aas:kind>Instance</aas:kind>
            <aas:qualifier />
            <aas:valueType>string</aas:valueType>
            <aas:value>${xmlEscape(value)}</aas:value>
          </aas:property>
        </aas:submodelElement>`;
}

function documentCollectionXml(index, doc) {
  const collId = `Document${String(index + 1).padStart(2, '0')}`;
  const fileId = String(index + 1).padStart(4, '0');
  return `        <aas:submodelElement>
          <aas:submodelElementCollection>
            <aas:idShort>${collId}</aas:idShort>
            <aas:kind>Instance</aas:kind>
            <aas:qualifier />
            <aas:value>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>VDI2770_Title</aas:idShort>
                  <aas:kind>Instance</aas:kind>
                  <aas:qualifier />
                  <aas:valueType>string</aas:valueType>
                  <aas:value>${xmlEscape(doc.title)}</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>VDI2770_FileId</aas:idShort>
                  <aas:kind>Instance</aas:kind>
                  <aas:qualifier />
                  <aas:valueType>string</aas:valueType>
                  <aas:value>${fileId}</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>VDI2770_FileName</aas:idShort>
                  <aas:kind>Instance</aas:kind>
                  <aas:qualifier />
                  <aas:valueType>string</aas:valueType>
                  <aas:value>${xmlEscape(doc.zipName)}</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:property>
                  <aas:idShort>VDI2770_FileFormat</aas:idShort>
                  <aas:kind>Instance</aas:kind>
                  <aas:qualifier />
                  <aas:valueType>string</aas:valueType>
                  <aas:value>application/pdf</aas:value>
                </aas:property>
              </aas:submodelElement>
              <aas:submodelElement>
                <aas:file>
                  <aas:idShort>File</aas:idShort>
                  <aas:kind>Instance</aas:kind>
                  <aas:qualifier />
                  <aas:mimeType>application/pdf</aas:mimeType>
                  <aas:value>/aasx/Documentation/${xmlEscape(doc.zipName)}</aas:value>
                </aas:file>
              </aas:submodelElement>
            </aas:value>
          </aas:submodelElementCollection>
        </aas:submodelElement>`;
}

// ─── Build AAS XML ─────────────────────────────────────────────────────
function buildAasXml() {
  const aasFolder = `http___${AAS_ID
    .replace(/^https?:\/\//, '')
    .replace(/[^\w]/g, '_')}`;

  const nameplateProps = NAMEPLATE.map(([id, v]) => propertyXml(id, v)).join('\n');
  const techProps = TECHNICAL_DATA.map(([id, v]) => propertyXml(id, v)).join('\n');
  const docCollections = PDF_SOURCES.map((d, i) => documentCollectionXml(i, d)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<aas:aasenv xmlns:aas="http://www.admin-shell.io/aas/2/0"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
            xmlns:IEC="http://www.admin-shell.io/IEC61360/2/0">
  <aas:assetAdministrationShells>
    <aas:assetAdministrationShell>
      <aas:idShort>${xmlEscape(ID_SHORT)}</aas:idShort>
      <aas:identification idType="IRI">${xmlEscape(AAS_ID)}</aas:identification>
      <aas:assetRef>
        <aas:keys>
          <aas:key type="Asset" local="true" idType="IRI">${xmlEscape(ASSET_ID)}</aas:key>
        </aas:keys>
      </aas:assetRef>
      <aas:submodelRefs>
        <aas:submodelRef>
          <aas:keys>
            <aas:key type="Submodel" local="true" idType="IRI">${xmlEscape(AAS_ID)}/Nameplate</aas:key>
          </aas:keys>
        </aas:submodelRef>
        <aas:submodelRef>
          <aas:keys>
            <aas:key type="Submodel" local="true" idType="IRI">${xmlEscape(AAS_ID)}/TechnicalData</aas:key>
          </aas:keys>
        </aas:submodelRef>
        <aas:submodelRef>
          <aas:keys>
            <aas:key type="Submodel" local="true" idType="IRI">${xmlEscape(AAS_ID)}/Documentation</aas:key>
          </aas:keys>
        </aas:submodelRef>
      </aas:submodelRefs>
    </aas:assetAdministrationShell>
  </aas:assetAdministrationShells>

  <aas:assets>
    <aas:asset>
      <aas:idShort>${xmlEscape(ID_SHORT)}_Asset</aas:idShort>
      <aas:identification idType="IRI">${xmlEscape(ASSET_ID)}</aas:identification>
      <aas:kind>Instance</aas:kind>
    </aas:asset>
  </aas:assets>

  <aas:submodels>
    <aas:submodel>
      <aas:idShort>Nameplate</aas:idShort>
      <aas:identification idType="IRI">${xmlEscape(AAS_ID)}/Nameplate</aas:identification>
      <aas:kind>Instance</aas:kind>
      <aas:submodelElements>
${nameplateProps}
      </aas:submodelElements>
    </aas:submodel>

    <aas:submodel>
      <aas:idShort>TechnicalData</aas:idShort>
      <aas:identification idType="IRI">${xmlEscape(AAS_ID)}/TechnicalData</aas:identification>
      <aas:kind>Instance</aas:kind>
      <aas:submodelElements>
${techProps}
      </aas:submodelElements>
    </aas:submodel>

    <aas:submodel>
      <aas:idShort>Documentation</aas:idShort>
      <aas:identification idType="IRI">${xmlEscape(AAS_ID)}/Documentation</aas:identification>
      <aas:kind>Instance</aas:kind>
      <aas:submodelElements>
${docCollections}
      </aas:submodelElements>
    </aas:submodel>
  </aas:submodels>
</aas:aasenv>
`;
}

// ─── Build AASX (OPC ZIP with mandatory part-relationship structure) ──
async function buildAasx() {
  const aasFolder = `http___${AAS_ID
    .replace(/^https?:\/\//, '')
    .replace(/[^\w]/g, '_')}`;
  const aasXmlPath = `aasx/${aasFolder}/${aasFolder}.aas.xml`;

  const zip = new JSZip();

  // [Content_Types].xml — OPC requirement
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Default Extension="pdf" ContentType="application/pdf"/>
</Types>
`);

  // Package-level relationship pointing to aasx-origin
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Type="http://www.admin-shell.io/aasx/relationships/aasx-origin" Target="/aasx/aasx-origin"/>
</Relationships>
`);

  // aasx-origin marker
  zip.file('aasx/aasx-origin', '');

  // aasx-origin -> aas-spec relationship
  zip.file('aasx/_rels/aasx-origin.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel1" Type="http://www.admin-shell.io/aasx/relationships/aas-spec" Target="/${aasXmlPath}"/>
</Relationships>
`);

  // The actual AAS XML
  zip.file(aasXmlPath, buildAasXml());

  // aas-spec -> supplementary file relationships (one per PDF)
  const supplRels = PDF_SOURCES.map((d, i) =>
    `  <Relationship Id="rel_pdf_${i + 1}" Type="http://www.admin-shell.io/aasx/relationships/aas-suppl" Target="/aasx/Documentation/${d.zipName}"/>`,
  ).join('\n');
  zip.file(`aasx/${aasFolder}/_rels/${aasFolder}.aas.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${supplRels}
</Relationships>
`);

  // Embed PDFs
  for (const doc of PDF_SOURCES) {
    if (!existsSync(doc.src)) {
      console.error(`  ! missing source PDF: ${doc.src}`);
      throw new Error(`PDF not found: ${doc.src}`);
    }
    const data = readFileSync(doc.src);
    zip.file(`aasx/Documentation/${doc.zipName}`, data);
    console.log(`  + embedded ${basename(doc.src)} (${(data.length / 1024).toFixed(0)} KB)`);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(OUT_PATH, buf);
  console.log(`\n  AASX written: ${OUT_PATH} (${(buf.length / 1024).toFixed(0)} KB)`);
  console.log(`  AAS ID: ${AAS_ID}`);
}

buildAasx().catch(err => {
  console.error(err);
  process.exit(1);
});
