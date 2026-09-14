/**
 * One-time generator: creates config/tenant-overrides/{slug}.yml for all WD5 tenants.
 * Run from auto-apply/: node scripts/generate-wd5-tenants.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'config', 'tenant-overrides');

/** @type {[string, string][]} [displayName, hostname slug] */
const WD5_TENANTS = [
  ['Abcfinancial', 'abcfinancial'],
  ['Advanceauto', 'advanceauto'],
  ['Aero', 'aero'],
  ['Agilent', 'agilent'],
  ['Allegion', 'allegion'],
  ['Allina', 'allina'],
  ['Amcor', 'amcor'],
  ['Ameriprise', 'ameriprise'],
  ['Aptiv', 'aptiv'],
  ['Ardentmills', 'ardentmills'],
  ['Atcllc', 'atcllc'],
  ['Athene', 'athene'],
  ['Avera', 'avera'],
  ['Bakertilly', 'bakertilly'],
  ['Blattner', 'blattner'],
  ['Bluescopenac', 'bluescopenac'],
  ['Borgwarner', 'borgwarner'],
  ['Brandeis', 'brandeis'],
  ['Breakthru', 'breakthru'],
  ['Bridgestone', 'bridgestone'],
  ['Bristolmyerssquibb', 'bristolmyerssquibb'],
  ['Burlington', 'burlington'],
  ['Cambridgeassociates', 'cambridgeassociates'],
  ['Campbellsoup', 'campbellsoup'],
  ['Canadiansolar', 'canadiansolar'],
  ['Cenhud', 'cenhud'],
  ['Chartermfg', 'chartermfg'],
  ['Childrensinstitute', 'childrensinstitute'],
  ['Choicehotels', 'choicehotels'],
  ['Clarios', 'clarios'],
  ['Clr', 'clr'],
  ['Coxhealth', 'coxhealth'],
  ['Crowdstrike', 'crowdstrike'],
  ['Deluxe', 'deluxe'],
  ['Dimensional', 'dimensional'],
  ['Dmainc', 'dmainc'],
  ['Dtna', 'dtna'],
  ['Ebi', 'ebi'],
  ['Edwards', 'edwards'],
  ['Ehealthinsurance', 'ehealthinsurance'],
  ['Ensemblehp', 'ensemblehp'],
  ['Ffive', 'ffive'],
  ['Fifththird', 'fifththird'],
  ['Flagstar', 'flagstar'],
  ['Gartner', 'gartner'],
  ['Generac', 'generac'],
  ['Generalmotors', 'generalmotors'],
  ['Genevausa', 'genevausa'],
  ['Gentex', 'gentex'],
  ['Gfs', 'gfs'],
  ['Globusmedical', 'globusmedical'],
  ['Goodwillmiddletn', 'goodwillmiddletn'],
  ['Grammy', 'grammy'],
  ['Greenheckgroup', 'greenheckgroup'],
  ['Group1001Wd', 'group1001wd'],
  ['Gsk', 'gsk'],
  ['Hp', 'hp'],
  ['Hpinc', 'hpinc'],
  ['Huntingtonhospital', 'huntingtonhospital'],
  ['Idexcorp', 'idexcorp'],
  ['Ilitch', 'ilitch'],
  ['Insulet', 'insulet'],
  ['Interiorlogicgroup', 'interiorlogicgroup'],
  ['Jabil', 'jabil'],
  ['Jainglobal', 'jainglobal'],
  ['Jda', 'jda'],
  ['Jeffersonhealth', 'jeffersonhealth'],
  ['Kemper', 'kemper'],
  ['Keybank', 'keybank'],
  ['Kumc', 'kumc'],
  ['Kyndryl', 'kyndryl'],
  ['Liberty', 'liberty'],
  ['Lifestance', 'lifestance'],
  ['Lnw', 'lnw'],
  ['Lumentum', 'lumentum'],
  ['Medline', 'medline'],
  ['Meijer', 'meijer'],
  ['Mii', 'mii'],
  ['Mimecast', 'mimecast'],
  ['Moog', 'moog'],
  ['Morningstar', 'morningstar'],
  ['Motorolasolutions', 'motorolasolutions'],
  ['Mtb', 'mtb'],
  ['Mydpr', 'mydpr'],
  ['Nationwidechildrens', 'nationwidechildrens'],
  ['Nebraskamed', 'nebraskamed'],
  ['Neurocrine', 'neurocrine'],
  ['Nphosting', 'nphosting'],
  ['Nvent', 'nvent'],
  ['Nvidia', 'nvidia'],
  ['O9Solutions', 'o9solutions'],
  ['Oceanspray', 'oceanspray'],
  ['Odl', 'odl'],
  ['Onemagnify', 'onemagnify'],
  ['Oregon', 'oregon'],
  ['Oumedicine', 'oumedicine'],
  ['Oxy', 'oxy'],
  ['Palomarhealth', 'palomarhealth'],
  ['Pentair', 'pentair'],
  ['Pfm', 'pfm'],
  ['Progleasing', 'progleasing'],
  ['Proofpoint', 'proofpoint'],
  ['Pru', 'pru'],
  ['Qtsdatacenters', 'qtsdatacenters'],
  ['Qualys', 'qualys'],
  ['Qvc', 'qvc'],
  ['Rallyhouse', 'rallyhouse'],
  ['Redhat', 'redhat'],
  ['Rochester', 'rochester'],
  ['Rocket', 'rocket'],
  ['Rrhs', 'rrhs'],
  ['Ryancompanies', 'ryancompanies'],
  ['Sbasite', 'sbasite'],
  ['Sgadental', 'sgadental'],
  ['Shelterinsurance', 'shelterinsurance'],
  ['Shm', 'shm'],
  ['Skechers', 'skechers'],
  ['Southshorehealth', 'southshorehealth'],
  ['Standardtextile', 'standardtextile'],
  ['Synnex', 'synnex'],
  ['Tempus', 'tempus'],
  ['Theocc', 'theocc'],
  ['Thinkbrg', 'thinkbrg'],
  ['Thrivent', 'thrivent'],
  ['Transamerica', 'transamerica'],
  ['Transunion', 'transunion'],
  ['Troweprice', 'troweprice'],
  ['Tysonfoods', 'tysonfoods'],
  ['Uchicago', 'uchicago'],
  ['Umusic', 'umusic'],
  ['Unisys', 'unisys'],
  ['Usc', 'usc'],
  ['Velera', 'velera'],
  ['Vfc', 'vfc'],
  ['Vibrant', 'vibrant'],
  ['Visa', 'visa'],
  ['Vst', 'vst'],
  ['Washpost', 'washpost'],
  ['Wattswater', 'wattswater'],
  ['Wesleyan', 'wesleyan'],
  ['Westernalliancebank', 'westernalliancebank'],
  ['Wgu', 'wgu'],
  ['Workday', 'workday'],
  ['Xenergy', 'xenergy'],
];

const FIELD_OVERRIDES = `field_overrides:
  - ["how did you hear about us", "personal.source"]
  - ["phone device type", "_static.Mobile"]
  - ["have you previously been employed", "_static.No"]
  - ["have you ever been employed", "_static.No"]
  - ["do you have any relatives", "_static.No"]
  - ["do you have a relative", "_static.No"]
  - ["are you currently or have you ever worked", "_static.No"]
  - ["contract worker or consultant", "_static.No"]
  - ["job title", "experience.current_title"]
  - ["company", "experience.current_company"]
  - ["location", "experience.location"]
  - ["from", "experience.from_date"]
  - ["to", "experience.to_date"]
  - ["school or university", "education.university"]
  - ["degree", "education.degree"]
  - ["field of study", "education.field_of_study_hierarchy"]
  - ["city", "personal.city"]
`;

function buildYaml(displayName, slug) {
  return `# ${displayName} — YAML keyed by tenant slug "${slug}" (any wd* platform)
${FIELD_OVERRIDES}`;
}

mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
for (const [displayName, slug] of WD5_TENANTS) {
  const path = resolve(OUT_DIR, `${slug}.yml`);
  writeFileSync(path, buildYaml(displayName, slug), 'utf-8');
  written++;
}

const manifestPath = resolve(__dirname, '..', 'config', 'wd5-tenants.json');
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      domain: 'wd5',
      count: WD5_TENANTS.length,
      tenants: WD5_TENANTS.map(([name, slug]) => ({
        name,
        slug,
        host: `${slug}.wd5.myworkdayjobs.com`,
        overrideFile: `config/tenant-overrides/${slug}.yml`,
      })),
    },
    null,
    2,
  ),
  'utf-8',
);

console.log(`Wrote ${written} tenant override files to ${OUT_DIR}`);
console.log(`Manifest: ${manifestPath}`);
