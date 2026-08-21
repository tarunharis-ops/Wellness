// Single source of truth for dropdown option lists, field schema, and
// aggregation bucket mappings. Mirrors the dropdown lists (Data Validation)
// and the aggregation formulas found in "(Do Not Disturb) Main template .xlsx".
//
// Where the original workbook's aggregation formulas had drifted out of sync
// with its own dropdown lists (options added to the dropdown that were never
// added to a count bucket, or formulas referencing options no longer in the
// dropdown), this file reconciles them against the *actual* dropdown lists so
// every selectable value is counted somewhere on the dashboard. Notable fixes:
//   - "Suicidal Ideation/Self Harm" and "Threat to Others" are now their own
//     concern-category buckets (previously selectable but never counted).
//   - Program breakdown covers all 32 current program options (previously a
//     handful of newer/online variants were uncounted).
//   - Referral Type breakdown covers all 34 current destinations (previously
//     "Columbia HR" and "Reporting Form" were uncounted).

'use strict';

const CASE_STATUS = ['Active', 'Monitoring', 'Closed'];

const YES_NO = ['Yes', 'No'];

const PROGRAMS = [
  'Actuarial Science', 'Applied Analytics', 'Bioethics', 'Bioethics (Online)',
  'Construction Administration', 'Enterprise Risk Management', 'ERM (Online)',
  'Human Capital Management', 'Information and Knowledge Strategy',
  'Insurance Management', 'Narrative Medicine', 'Negotiation and Conflict Resolution',
  'Nonprofit Management', 'Nonprofit Management (Online)', 'Political Analytics',
  'Sports Management', 'Strategic Communication', 'Sustainability Management',
  'Sustainability Science', 'Technology Management', 'Wealth Management',
  'Wealth Managment (Online)',
  'Auditing Program', 'Certificate/Certification', 'Visiting Undergrad/Grad',
  'Other Non-Degree', 'Alumni', 'College Edge', 'Summer Immersion HS',
  'Academic Immersion', 'Not Current Student', 'ALP',
];

const MODALITY = ['In Person', 'Online Only', 'N/A'];

const ENROLLMENT = ['Full Time', 'Part Time', 'Voluntary Leave', 'Medical Leave', 'Not Enrolled', 'Non Affiliate', 'Alumni'];

const NABITA = ['Mild', 'Moderate', 'Elevated', 'Critical'];

const REFERRAL_SOURCE = [
  'CARE Team Referral Form', 'Faculty Referral (Non Maxient)', 'Staff Referral (Non-Maxient)',
  'Self-Referral', 'Emergency Fund Application', 'University Partner', 'Medical Leave of Absence Request',
];

const OUTREACH_TYPE = ['Direct', 'Indirect/Administrative'];

const OUTREACH_METHOD = ['Call/Video', 'Email', 'Text/Chat', 'Self-request form', 'Reporting', 'In-Person', 'Admin'];

const OUTREACH_CONDUCTED = [
  'Wellness Check', 'Initial Wellness Outreach', 'Resource Share', 'Meeting Offered', 'Meeting Held',
  'Follow-Up Check-In', 'Consultation with Staff/Faculty', 'Consultation with Outside Provider',
  'Report Filed', 'EF Application Processing', 'Medical Leave Processing', 'Request for Other Information',
  'Referral Follow Up', 'Close Out', 'Administrative', 'Meeting Follow Up Email', 'Family/Friend Contact',
  'Second Wellness Outreach', 'Third Wellness Outreach',
];

const OUTREACH_OUTCOME = [
  'Awaiting Response', 'Meeting Scheduled', 'Student Declined', 'Remote Meeting', 'In-Person Meeting',
  'Meeting No-Show', 'Consultation', 'Student Requested Support Via Email', 'Confirmed Receipt of Information',
  'Student Meeting Cancelled', 'N/A- Administrative', 'Left Voicemail', 'Email Follow Up', 'No Response',
  'Connection Email/Call', 'Phone Call',
];

const CONCERNS = [
  'Mental Health Concerns', 'Physical Health Concerns', 'Academic Performance / Disengagement',
  'Financial Concerns', 'Food Insecurity', 'Concerns Navigating Columbia', 'Concerns Navigating Beyond Columbia',
  'Medical Leave', 'Housing Concerns', 'Grief/Loss', 'Suicidal Ideation/Self Harm', 'Substance Concerns',
  'Family/Personal Emergency', 'Interpersonal Concern', 'Threat to Others', 'Missing/Unresponsive Student',
  'General Well-Being Concerns', 'Emergency Fund', 'Campus Climate', 'Employment Concerns',
];

const REFERRALS_MADE = ['Columbia Resource', 'External Resource', 'Both'];

const REFERRAL_TYPES = [
  'Medical Services', 'CPS', 'Alice!', 'SVR', 'Disability Services', 'Insurance Office', 'Dodge',
  'Student Financial Services', 'Student Service Center', 'Religious Life', 'Advising', 'Student Support',
  'Student Life / University Life', 'Legal Services', 'Off Campus - See notes', 'Public Safety',
  'Columbia Transportation', 'Career Design Lab', 'On-Campus Jobs', 'ISSO', 'Food Pantry', 'Emergency Fund',
  'Columbia HR', 'Other (See Notes)', 'Urgent Support Lines', 'Reporting Form', 'Ombuds Office', 'Title IX',
  'Office of Work/Life', 'CSSI', 'OIE', 'Headspace', 'iGrad', 'CU Res',
];

// ---- Option groups ----
// Each editable dropdown list lives under a group key. Several fields share
// one group (e.g. the three concern fields all edit the same "concern" list),
// so admins manage one list instead of three that could drift apart. Defaults
// here seed the template_options table on first run — see db/migrate.js.
const OPTION_GROUPS = [
  { key: 'caseStatus', label: 'Case Status', defaults: CASE_STATUS },
  { key: 'yesNo', label: 'Yes / No', defaults: YES_NO },
  { key: 'program', label: 'Program', defaults: PROGRAMS },
  { key: 'modality', label: 'Modality (In Person / Online)', defaults: MODALITY },
  { key: 'enrollmentStatus', label: 'Enrollment Status', defaults: ENROLLMENT },
  { key: 'nabitaRisk', label: 'NABITA Risk Rubric', defaults: NABITA },
  { key: 'referralSource', label: 'Referral Source', defaults: REFERRAL_SOURCE },
  { key: 'outreachType', label: 'Outreach Type', defaults: OUTREACH_TYPE },
  { key: 'outreachMethod', label: 'Outreach Method', defaults: OUTREACH_METHOD },
  { key: 'outreachConducted', label: 'Outreach Conducted', defaults: OUTREACH_CONDUCTED },
  { key: 'outreachOutcome', label: 'Outreach Outcome', defaults: OUTREACH_OUTCOME },
  { key: 'concern', label: 'Wellness Concerns (Primary / Secondary / Tertiary)', defaults: CONCERNS },
  { key: 'referralsMade', label: 'Referrals Made', defaults: REFERRALS_MADE },
  { key: 'referralType', label: 'Referral Type (Primary / Secondary / Tertiary)', defaults: REFERRAL_TYPES },
];

// ---- Field schema (drives the entry form, table columns, and CSV export) ----
// section groups fields into the entry-form drawer's collapsible sections.
// optionGroup points select fields at their live (DB-backed) option list.
const FIELDS = [
  { key: 'caseStatus', label: 'Case Status', type: 'select', optionGroup: 'caseStatus', section: 'case', required: true, default: 'Active' },
  { key: 'firstName', label: 'First Name', type: 'text', section: 'case', required: true },
  { key: 'lastName', label: 'Last Name', type: 'text', section: 'case', required: true },
  { key: 'studentIdExternal', label: 'Student ID (optional)', type: 'text', section: 'case' },
  { key: 'pronouns', label: 'Pronouns (if known)', type: 'text', section: 'case' },
  { key: 'international', label: 'International Student? (Via SSOL)', type: 'select', optionGroup: 'yesNo', section: 'case' },
  { key: 'program', label: 'Program', type: 'select', optionGroup: 'program', section: 'case' },
  { key: 'modality', label: 'In Person or Online Only', type: 'select', optionGroup: 'modality', section: 'case' },
  { key: 'enrollmentStatus', label: 'Enrollment Status (Via SSOL)', type: 'select', optionGroup: 'enrollmentStatus', section: 'case' },
  { key: 'columbiaOfficer', label: 'Columbia Officer?', type: 'select', optionGroup: 'yesNo', section: 'case' },
  { key: 'nabitaRisk', label: 'NABITA Risk Rubric', type: 'select', optionGroup: 'nabitaRisk', section: 'referral' },
  { key: 'referralSource', label: 'Referral Source', type: 'select', optionGroup: 'referralSource', section: 'referral' },
  { key: 'referralDate', label: 'Referral Date', type: 'date', section: 'referral' },
  { key: 'outreachType', label: 'Outreach Type', type: 'select', optionGroup: 'outreachType', section: 'outreach' },
  { key: 'outreachMethod', label: 'Outreach Method', type: 'select', optionGroup: 'outreachMethod', section: 'outreach' },
  { key: 'outreachDate', label: 'Outreach Date', type: 'date', section: 'outreach' },
  { key: 'outreachConducted', label: 'Outreach Conducted', type: 'select', optionGroup: 'outreachConducted', section: 'outreach' },
  { key: 'durationMinutes', label: 'Duration of Outreach (in minutes)', type: 'number', section: 'outreach' },
  { key: 'outreachOutcome', label: 'Outreach Outcome', type: 'select', optionGroup: 'outreachOutcome', section: 'outreach' },
  { key: 'concernPrimary', label: 'Wellness Primary Concern', type: 'select', optionGroup: 'concern', section: 'concerns' },
  { key: 'concernSecondary', label: 'Wellness Secondary Concern', type: 'select', optionGroup: 'concern', section: 'concerns' },
  { key: 'concernTertiary', label: 'Wellness Tertiary Concern', type: 'select', optionGroup: 'concern', section: 'concerns' },
  { key: 'referralsMade', label: 'Referrals Made', type: 'select', optionGroup: 'referralsMade', section: 'referrals' },
  { key: 'referralPrimary', label: 'Referral Primary', type: 'select', optionGroup: 'referralType', section: 'referrals' },
  { key: 'referralSecondary', label: 'Referral Secondary', type: 'select', optionGroup: 'referralType', section: 'referrals' },
  { key: 'referralTertiary', label: 'Referral Tertiary', type: 'select', optionGroup: 'referralType', section: 'referrals' },
  { key: 'notes', label: 'Notes', type: 'textarea', section: 'notes' },
];

const SECTIONS = [
  { key: 'case', label: 'Student & Case Info' },
  { key: 'referral', label: 'Referral' },
  { key: 'outreach', label: 'Outreach' },
  { key: 'concerns', label: 'Wellness Concerns' },
  { key: 'referrals', label: 'Referrals Made' },
  { key: 'notes', label: 'Notes' },
];

// ---- Dashboard bucket mappings ----

const PROGRAM_BUCKETS = {
  'MS Degree Seeking': [
    'Actuarial Science', 'Applied Analytics', 'Bioethics', 'Bioethics (Online)',
    'Construction Administration', 'Enterprise Risk Management', 'ERM (Online)',
    'Human Capital Management', 'Information and Knowledge Strategy', 'Insurance Management',
    'Narrative Medicine', 'Negotiation and Conflict Resolution', 'Nonprofit Management',
    'Nonprofit Management (Online)', 'Political Analytics', 'Sports Management',
    'Strategic Communication', 'Sustainability Management', 'Sustainability Science',
    'Technology Management', 'Wealth Management', 'Wealth Managment (Online)',
  ],
  'Non-Degree / Other': [
    'Auditing Program', 'Certificate/Certification', 'Visiting Undergrad/Grad', 'Other Non-Degree',
    'Alumni', 'College Edge', 'Summer Immersion HS', 'Academic Immersion', 'Not Current Student', 'ALP',
  ],
};

const ENROLLMENT_BUCKETS = {
  'Full Time': ['Full Time'],
  'Part Time': ['Part Time'],
  'Not Currently Enrolled (LOA, Alum, Prospective)': ['Voluntary Leave', 'Medical Leave', 'Not Enrolled', 'Alumni'],
  'Non-Affiliate': ['Non Affiliate'],
};

const REFERRAL_SOURCE_BUCKETS = {
  'CARE Team Referral Form': ['CARE Team Referral Form'],
  'Self-Referral (incl. Emergency Fund & MLOA)': ['Self-Referral', 'Emergency Fund Application', 'Medical Leave of Absence Request'],
  'Staff/Faculty/University Partner Referrals': ['Faculty Referral (Non Maxient)', 'Staff Referral (Non-Maxient)', 'University Partner'],
};

const CONCERN_BUCKETS = {
  'Mental Health': ['Mental Health Concerns'],
  'Suicidal Ideation / Self-Harm': ['Suicidal Ideation/Self Harm'],
  'Threat to Others': ['Threat to Others'],
  'Physical Health': ['Physical Health Concerns'],
  'Academic Performance': ['Academic Performance / Disengagement'],
  'Basic Needs (Food/Housing)': ['Food Insecurity', 'Housing Concerns'],
  'Financial (incl. Emergency Fund)': ['Financial Concerns', 'Emergency Fund'],
  'Navigating Columbia': ['Concerns Navigating Columbia'],
  'Navigating Beyond Columbia': ['Concerns Navigating Beyond Columbia'],
  'Medical Leave of Absence': ['Medical Leave'],
  'Grief/Loss': ['Grief/Loss'],
  'Substance Concerns': ['Substance Concerns'],
  'Family/Personal Emergency': ['Family/Personal Emergency'],
  'Interpersonal Concerns': ['Interpersonal Concern'],
  'Missing/Unresponsive Student': ['Missing/Unresponsive Student'],
  'General Well-Being': ['General Well-Being Concerns'],
  'Campus Climate': ['Campus Climate'],
  'Employment Concerns': ['Employment Concerns'],
};

const HOURS_BUCKETS = {
  'Wellness Meetings': ['Meeting Held'],
  'Wellness Checks': ['Wellness Check'],
  'Wellness Outreach': [
    'Initial Wellness Outreach', 'Second Wellness Outreach', 'Third Wellness Outreach', 'Resource Share',
    'Meeting Offered', 'Follow-Up Check-In', 'Request for Other Information', 'Referral Follow Up',
    'Close Out', 'Meeting Follow Up Email',
  ],
  'Consultation': ['Consultation with Staff/Faculty', 'Consultation with Outside Provider', 'Family/Friend Contact'],
  'Administrative': ['Report Filed', 'EF Application Processing', 'Medical Leave Processing', 'Administrative'],
};

// CSV / spreadsheet export column order, matching the original Master Doc layout (A:Z).
const CSV_COLUMNS = [
  { key: 'caseStatus', header: 'Case Status' },
  { key: 'firstName', header: 'First Name' },
  { key: 'lastName', header: 'Last Name' },
  { key: 'studentIdExternal', header: 'Student ID' },
  { key: 'pronouns', header: 'Pronouns (if known)' },
  { key: 'international', header: 'International Student? (Via SSOL)' },
  { key: 'program', header: 'Program' },
  { key: 'modality', header: 'In person or online only' },
  { key: 'enrollmentStatus', header: 'Enrollment Status (Via SSOL)' },
  { key: 'columbiaOfficer', header: 'Columbia Officer?' },
  { key: 'nabitaRisk', header: 'NABITA Risk Rubric' },
  { key: 'referralSource', header: 'Referral Source' },
  { key: 'referralDate', header: 'Referral Date' },
  { key: 'outreachType', header: 'Outreach Type' },
  { key: 'outreachMethod', header: 'Outreach Method' },
  { key: 'outreachDate', header: 'Outreach Date' },
  { key: 'outreachConducted', header: 'Outreach Conducted' },
  { key: 'durationMinutes', header: 'Duration of Outreach (in minutes)' },
  { key: 'outreachOutcome', header: 'Outreach Outcome' },
  { key: 'concernPrimary', header: 'Wellness Primary Concern' },
  { key: 'concernSecondary', header: 'Wellness Secondary Concern' },
  { key: 'concernTertiary', header: 'Wellness Tertiary Concern' },
  { key: 'referralsMade', header: 'Referrals Made' },
  { key: 'referralPrimary', header: 'Referral Primary' },
  { key: 'referralSecondary', header: 'Referral Secondary' },
  { key: 'referralTertiary', header: 'Referral Tertiary' },
  { key: 'notes', header: 'Notes' },
];

module.exports = {
  CASE_STATUS, YES_NO, PROGRAMS, MODALITY, ENROLLMENT, NABITA, REFERRAL_SOURCE,
  OUTREACH_TYPE, OUTREACH_METHOD, OUTREACH_CONDUCTED, OUTREACH_OUTCOME, CONCERNS,
  REFERRALS_MADE, REFERRAL_TYPES, FIELDS, SECTIONS, OPTION_GROUPS,
  PROGRAM_BUCKETS, ENROLLMENT_BUCKETS, REFERRAL_SOURCE_BUCKETS, CONCERN_BUCKETS, HOURS_BUCKETS,
  CSV_COLUMNS,
};
