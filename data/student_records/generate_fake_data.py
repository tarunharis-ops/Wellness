#!/usr/bin/env python3
"""
generate_fake_data.py

Generates a fully SYNTHETIC dataset for a demo student conduct / case
management application.

IMPORTANT:
- The "university" (Alderbrook University), all people, addresses,
  emails, and incidents are entirely fictional / randomly generated.
- No real individuals, institutions, or scraped data are used.
- This script is deterministic (seeded) so it can be re-run to
  reproduce the same dataset.

Output:
    data/raw/students.csv
    data/raw/housing.csv
    data/raw/campus_safety.csv
    data/raw/academic_integrity.csv
    data/raw/reports.csv
    data/raw/README.md

Run:
    python3 scripts/generate_fake_data.py
"""

import csv
import os
import random
from datetime import date, timedelta

from faker import Faker

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

SEED = 42
random.seed(SEED)

fake = Faker()
Faker.seed(SEED)

NUM_STUDENTS = 10_000

# Fictional institution details
UNIVERSITY_NAME = "Alderbrook University"
EMAIL_DOMAIN = "alderbrook.edu"

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "raw")

TODAY = date(2026, 8, 20)  # generation reference date

# --------------------------------------------------------------------------
# Reference data pools (all fictional)
# --------------------------------------------------------------------------

MAJORS = [
    "Computer Science", "Biology", "Psychology", "Business Administration",
    "Mechanical Engineering", "Electrical Engineering", "Nursing",
    "English Literature", "History", "Political Science", "Economics",
    "Mathematics", "Chemistry", "Physics", "Sociology", "Art History",
    "Graphic Design", "Communications", "Environmental Science",
    "Criminal Justice", "Music Performance", "Theatre Arts",
    "Kinesiology", "Finance", "Marketing", "Accounting",
    "Civil Engineering", "Data Science", "Philosophy", "Anthropology",
    "Undeclared",
]

ACADEMIC_YEARS = ["Freshman", "Sophomore", "Junior", "Senior", "Graduate"]
ACADEMIC_YEAR_WEIGHTS = [0.24, 0.23, 0.22, 0.21, 0.10]

ENROLLMENT_STATUSES = ["Enrolled", "Leave of Absence", "Graduated", "Withdrawn"]
ENROLLMENT_STATUS_WEIGHTS = [0.86, 0.04, 0.06, 0.04]

# A fixed pool of fictional faculty advisors (reused across students)
ADVISOR_TITLES = ["Dr.", "Prof."]
ADVISOR_POOL = [
    f"{random.choice(ADVISOR_TITLES)} {fake.first_name()} {fake.last_name()}"
    for _ in range(60)
]

# Fictional residence halls
RESIDENCE_HALLS = [
    "Birchwood Hall", "Sunrise Commons", "Maple Ridge Hall", "Harborview Hall",
    "Cedar Crest Hall", "Founders Hall", "Lakeside Terrace", "Northgate Hall",
    "Willow Creek Hall", "Summit House", "Bellview Hall", "Aspen Court",
    "Riverbend Hall", "Highland Hall", "Meadowbrook Hall",
]

HOUSING_STATUSES = ["Active", "Moved Out", "Pending Assignment"]
HOUSING_STATUS_WEIGHTS = [0.62, 0.33, 0.05]

# Campus Safety reference data
SAFETY_LOCATIONS = RESIDENCE_HALLS + [
    "Main Quad", "Student Union", "West Parking Garage", "East Lot",
    "Library", "Recreation Center", "Science Building", "Engineering Annex",
    "Fine Arts Center", "Off-Campus Housing", "Stadium", "Bike Path",
]

INCIDENT_TYPES = [
    "Noise Complaint", "Alcohol Policy Violation", "Theft", "Vandalism",
    "Fire Alarm Activation", "Physical Altercation", "Trespassing",
    "Drug Policy Violation", "Medical Emergency", "Harassment",
    "Weapons Policy Violation", "Suspicious Activity", "Disorderly Conduct",
]

SAFETY_SEVERITIES = ["Low", "Medium", "High", "Critical"]
SAFETY_SEVERITY_WEIGHTS = [0.45, 0.32, 0.18, 0.05]

SAFETY_STATUSES = ["Open", "Under Investigation", "Closed", "Referred to Conduct Board"]
SAFETY_STATUS_WEIGHTS = [0.12, 0.15, 0.63, 0.10]

SAFETY_NARRATIVE_TEMPLATES = [
    "Reporting officer responded to {location} regarding a {incident_type_lc} involving the listed student.",
    "Incident occurred at {location}. Responding staff documented a {incident_type_lc}.",
    "Student was involved in a {incident_type_lc} reported near {location}.",
    "Campus Safety was dispatched to {location} after a report of {incident_type_lc}.",
    "A {incident_type_lc} was observed and documented at {location}.",
]

# Academic Integrity reference data
DEPARTMENTS = {
    "CS": "Computer Science", "BIO": "Biology", "PSY": "Psychology",
    "BUS": "Business Administration", "ME": "Mechanical Engineering",
    "EE": "Electrical Engineering", "NUR": "Nursing", "ENG": "English",
    "HIST": "History", "POL": "Political Science", "ECON": "Economics",
    "MATH": "Mathematics", "CHEM": "Chemistry", "PHYS": "Physics",
    "SOC": "Sociology",
}

COURSE_NAME_TEMPLATES = [
    "Introduction to {dept}", "Intermediate {dept}", "Advanced {dept}",
    "{dept} Seminar", "Principles of {dept}", "{dept} Fundamentals",
    "Topics in {dept}",
]

VIOLATION_TYPES = [
    "Plagiarism", "Unauthorized Collaboration", "Cheating on Exam",
    "Fabrication of Data", "Contract Cheating", "Unauthorized Use of AI Tools",
    "Duplicate Submission", "Exam Impersonation", "Unauthorized Materials",
]

INTEGRITY_SEVERITIES = ["Minor", "Moderate", "Serious", "Severe"]
INTEGRITY_SEVERITY_WEIGHTS = [0.35, 0.35, 0.22, 0.08]

INTEGRITY_STATUSES = ["Pending Review", "Under Investigation", "Resolved - Sanction Issued",
                       "Resolved - No Violation Found", "Appealed"]
INTEGRITY_STATUS_WEIGHTS = [0.14, 0.16, 0.48, 0.14, 0.08]

INTEGRITY_DESC_TEMPLATES = [
    "Faculty member reported a suspected case of {violation_lc} in a submitted assignment.",
    "During grading, {faculty} identified indicators consistent with {violation_lc}.",
    "A case of {violation_lc} was flagged via the course's academic integrity review process.",
    "Student was referred to the Academic Integrity Office for {violation_lc}.",
    "{faculty} submitted a report alleging {violation_lc} in {course_code}.",
]

# Web / Anonymous Reporting reference data
REPORTER_TYPES = ["Student", "Faculty", "Staff", "Parent", "Anonymous", "Community Member"]
REPORTER_TYPE_WEIGHTS = [0.42, 0.14, 0.12, 0.05, 0.22, 0.05]

REPORT_CATEGORIES = [
    "Academic Dishonesty", "Bullying/Harassment", "Discrimination",
    "Hazing", "Sexual Misconduct", "Alcohol/Drug Concern",
    "Mental Health Concern", "Safety Hazard", "Theft", "Property Damage",
    "Bias Incident", "Other",
]

REPORT_PRIORITIES = ["Low", "Medium", "High", "Urgent"]
REPORT_PRIORITY_WEIGHTS = [0.30, 0.40, 0.22, 0.08]

REPORT_LOCATIONS = SAFETY_LOCATIONS + ["Online / Remote", "Off-Campus"]

REPORT_DESC_TEMPLATES = [
    "Reporter describes an incident involving {category_lc} that occurred at {location}.",
    "A concern was submitted regarding possible {category_lc} near {location}.",
    "Reporter states they witnessed behavior consistent with {category_lc}.",
    "Submission describes an ongoing issue related to {category_lc} at {location}.",
    "Concern raised about {category_lc}; reporter requests follow-up from staff.",
]

STREET_SUFFIXES = ["St", "Ave", "Ln", "Dr", "Rd", "Ct", "Way", "Blvd"]

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def weighted_choice(options, weights):
    return random.choices(options, weights=weights, k=1)[0]


def random_date_between(start: date, end: date) -> date:
    if end <= start:
        return start
    delta_days = (end - start).days
    return start + timedelta(days=random.randint(0, delta_days))


def make_student_id(index: int) -> str:
    return f"S{index:06d}"


def make_email(first, last, index, used_emails):
    base = f"{first}.{last}{index}".lower().replace(" ", "")
    base = "".join(ch for ch in base if ch.isalnum() or ch in ".")
    email = f"{base}@{EMAIL_DOMAIN}"
    used_emails.add(email)
    return email


def academic_year_to_enrollment_start(academic_year: str) -> date:
    """Approximate the year a student first enrolled, based on class standing."""
    years_enrolled = {
        "Freshman": 0,
        "Sophomore": 1,
        "Junior": 2,
        "Senior": 3,
        "Graduate": random.choice([0, 1]),
    }[academic_year]
    # Fall term start of the relevant year
    enrollment_year = TODAY.year - years_enrolled
    if TODAY.month < 8:
        enrollment_year -= 1
    return date(enrollment_year, 8, random.randint(15, 28))


def assign_with_repeats(student_ids, total_records, unique_ratio=0.82, repeat_pool_ratio=0.30):
    """
    Return a list of student_ids of length `total_records`, where most
    students appear once and a smaller subset appears multiple times,
    mimicking realistic repeat-incident behavior. Every id returned is a
    valid id drawn from `student_ids`.
    """
    total_records = max(0, total_records)
    num_unique = min(int(total_records * unique_ratio), len(student_ids), total_records)
    num_unique = max(num_unique, min(1, total_records))
    unique_students = random.sample(student_ids, num_unique)

    assignments = list(unique_students)
    remaining = total_records - len(assignments)

    if remaining > 0:
        pool_size = max(1, int(len(unique_students) * repeat_pool_ratio))
        repeat_pool = random.sample(unique_students, min(pool_size, len(unique_students)))
        for _ in range(remaining):
            assignments.append(random.choice(repeat_pool))

    random.shuffle(assignments)
    return assignments[:total_records]


def ensure_output_dir():
    os.makedirs(OUTPUT_DIR, exist_ok=True)


def write_csv(filename, fieldnames, rows):
    path = os.path.join(OUTPUT_DIR, filename)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    return path


# --------------------------------------------------------------------------
# Generators for each dataset
# --------------------------------------------------------------------------


def generate_students(n=NUM_STUDENTS):
    students = []
    used_emails = set()
    student_ids = []

    for i in range(1, n + 1):
        student_id = make_student_id(i)
        student_ids.append(student_id)

        first_name = fake.first_name()
        last_name = fake.last_name()
        email = make_email(first_name, last_name, i, used_emails)

        academic_year = weighted_choice(ACADEMIC_YEARS, ACADEMIC_YEAR_WEIGHTS)
        enrollment_status = weighted_choice(ENROLLMENT_STATUSES, ENROLLMENT_STATUS_WEIGHTS)
        enrollment_date = academic_year_to_enrollment_start(academic_year)

        # Age appropriate for standing: 18-23 undergrad, 22-35 graduate
        if academic_year == "Graduate":
            age_years = random.randint(22, 35)
        else:
            base_age = {"Freshman": 18, "Sophomore": 19, "Junior": 20, "Senior": 21}[academic_year]
            age_years = base_age + random.choice([0, 0, 0, 1, -1])
        dob = date(TODAY.year - age_years, random.randint(1, 12), random.randint(1, 28))

        major = weighted_choice(MAJORS, None) if False else random.choice(MAJORS)
        advisor = random.choice(ADVISOR_POOL)

        phone = fake.numerify("(###) ###-####")
        street = f"{random.randint(100, 9999)} {fake.last_name()} {random.choice(STREET_SUFFIXES)}"
        city = fake.city()
        state = fake.state_abbr()
        zip_code = fake.postcode()
        address = f"{street}, {city}, {state} {zip_code}"

        students.append({
            "student_id": student_id,
            "first_name": first_name,
            "last_name": last_name,
            "email": email,
            "dob": dob.isoformat(),
            "major": major,
            "academic_year": academic_year,
            "enrollment_status": enrollment_status,
            "advisor": advisor,
            "phone": phone,
            "address": address,
            "enrollment_date": enrollment_date.isoformat(),
        })

    return students, student_ids


def generate_housing(student_ids):
    num_with_housing = random.randint(6000, 7000)
    housed_students = random.sample(student_ids, num_with_housing)

    rows = []
    housing_id_counter = 1

    for student_id in housed_students:
        num_assignments = 1
        if random.random() < 0.08:  # small chance of a room change / second term
            num_assignments = 2

        # First assignment move-in date sometime in the last ~3 years
        move_in = random_date_between(date(TODAY.year - 3, 8, 1), TODAY)

        for assignment_num in range(num_assignments):
            hall = random.choice(RESIDENCE_HALLS)
            room_number = f"{random.randint(1, 5)}{random.randint(0, 9)}{random.randint(0, 9)}"
            status = weighted_choice(HOUSING_STATUSES, HOUSING_STATUS_WEIGHTS)

            if assignment_num > 0:
                move_in = move_in + timedelta(days=random.randint(120, 200))

            if status == "Moved Out":
                move_out = move_in + timedelta(days=random.randint(60, 300))
                if move_out > TODAY:
                    move_out = TODAY
            elif status == "Active":
                move_out = ""
            else:  # Pending Assignment
                move_out = ""

            rows.append({
                "housing_id": f"H{housing_id_counter:06d}",
                "student_id": student_id,
                "residence_hall": hall,
                "room_number": room_number,
                "move_in_date": move_in.isoformat(),
                "move_out_date": move_out.isoformat() if move_out else "",
                "housing_status": status,
            })
            housing_id_counter += 1

    random.shuffle(rows)
    # Renumber housing_id sequentially after shuffle for cleanliness
    for idx, row in enumerate(rows, start=1):
        row["housing_id"] = f"H{idx:06d}"

    return rows


def generate_campus_safety(student_ids):
    total_records = random.randint(700, 1000)
    assigned_students = assign_with_repeats(student_ids, total_records,
                                             unique_ratio=0.80, repeat_pool_ratio=0.25)

    rows = []
    window_start = date(TODAY.year - 2, 8, 1)

    for i, student_id in enumerate(assigned_students, start=1):
        incident_type = random.choice(INCIDENT_TYPES)
        location = random.choice(SAFETY_LOCATIONS)
        severity = weighted_choice(SAFETY_SEVERITIES, SAFETY_SEVERITY_WEIGHTS)
        status = weighted_choice(SAFETY_STATUSES, SAFETY_STATUS_WEIGHTS)
        incident_date = random_date_between(window_start, TODAY)

        template = random.choice(SAFETY_NARRATIVE_TEMPLATES)
        narrative = template.format(location=location, incident_type_lc=incident_type.lower())

        rows.append({
            "report_id": f"CS{i:06d}",
            "student_id": student_id,
            "incident_date": incident_date.isoformat(),
            "location": location,
            "incident_type": incident_type,
            "severity": severity,
            "status": status,
            "narrative": narrative,
        })

    rows.sort(key=lambda r: r["incident_date"])
    for idx, row in enumerate(rows, start=1):
        row["report_id"] = f"CS{idx:06d}"

    return rows


def generate_academic_integrity(student_ids):
    total_records = random.randint(400, 500)
    assigned_students = assign_with_repeats(student_ids, total_records,
                                             unique_ratio=0.85, repeat_pool_ratio=0.20)

    rows = []
    window_start = date(TODAY.year - 2, 8, 1)

    dept_codes = list(DEPARTMENTS.keys())

    for i, student_id in enumerate(assigned_students, start=1):
        dept_code = random.choice(dept_codes)
        dept_name = DEPARTMENTS[dept_code]
        course_code = f"{dept_code}{random.randint(100, 499)}"
        course_name = random.choice(COURSE_NAME_TEMPLATES).format(dept=dept_name)
        faculty_name = random.choice(ADVISOR_POOL)
        incident_date = random_date_between(window_start, TODAY)
        violation_type = random.choice(VIOLATION_TYPES)
        severity = weighted_choice(INTEGRITY_SEVERITIES, INTEGRITY_SEVERITY_WEIGHTS)
        status = weighted_choice(INTEGRITY_STATUSES, INTEGRITY_STATUS_WEIGHTS)

        template = random.choice(INTEGRITY_DESC_TEMPLATES)
        description = template.format(
            violation_lc=violation_type.lower(),
            faculty=faculty_name,
            course_code=course_code,
        )

        rows.append({
            "case_id": f"AI{i:06d}",
            "student_id": student_id,
            "course_code": course_code,
            "course_name": course_name,
            "faculty_name": faculty_name,
            "incident_date": incident_date.isoformat(),
            "violation_type": violation_type,
            "severity": severity,
            "status": status,
            "description": description,
        })

    rows.sort(key=lambda r: r["incident_date"])
    for idx, row in enumerate(rows, start=1):
        row["case_id"] = f"AI{idx:06d}"

    return rows


def generate_reports(student_ids):
    total_records = random.randint(800, 1000)

    # Decide, per report, whether a student is identified at all.
    # ~55% of reports name a student; the rest are either fully anonymous
    # or simply don't have an identifiable subject.
    window_start = date(TODAY.year - 2, 8, 1)

    # Pre-generate the "identified student" subset using the repeat logic
    # so some students show up in multiple web/anonymous reports.
    num_with_student = int(total_records * 0.55)
    students_for_reports = assign_with_repeats(student_ids, num_with_student,
                                                unique_ratio=0.85, repeat_pool_ratio=0.20)
    student_iter = iter(students_for_reports)

    rows = []
    for i in range(1, total_records + 1):
        category = random.choice(REPORT_CATEGORIES)
        location = random.choice(REPORT_LOCATIONS)
        priority = weighted_choice(REPORT_PRIORITIES, REPORT_PRIORITY_WEIGHTS)
        submitted_date = random_date_between(window_start, TODAY)

        has_student = i <= num_with_student
        reported_student_id = next(student_iter) if has_student else ""

        # Anonymous flag: reports with no identified reporter are more
        # likely to be anonymous, but a named reporter can also request
        # anonymity, and some reports without a named student are still
        # submitted by an identified reporter type.
        if random.random() < 0.35:
            anonymous = True
            reporter_type = "Anonymous"
        else:
            anonymous = False
            reporter_type = weighted_choice(
                [t for t in REPORTER_TYPES if t != "Anonymous"],
                [0.46, 0.16, 0.14, 0.06, 0.18],
            )

        template = random.choice(REPORT_DESC_TEMPLATES)
        description = template.format(category_lc=category.lower(), location=location)

        rows.append({
            "report_id": f"WR{i:06d}",
            "reported_student_id": reported_student_id,
            "reporter_type": reporter_type,
            "submitted_date": submitted_date.isoformat(),
            "category": category,
            "location": location,
            "priority": priority,
            "description": description,
            "anonymous": anonymous,
        })

    random.shuffle(rows)
    rows.sort(key=lambda r: r["submitted_date"])
    for idx, row in enumerate(rows, start=1):
        row["report_id"] = f"WR{idx:06d}"

    return rows


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------


def verify(students, housing, campus_safety, academic_integrity, reports):
    errors = []

    student_ids = [s["student_id"] for s in students]
    student_id_set = set(student_ids)

    if len(students) != NUM_STUDENTS:
        errors.append(f"Expected exactly {NUM_STUDENTS} students, found {len(students)}")

    if len(student_id_set) != len(student_ids):
        errors.append("Duplicate student_id values found in students.csv")

    emails = [s["email"] for s in students]
    if len(set(emails)) != len(emails):
        errors.append("Duplicate email values found in students.csv")

    def check_fk(rows, field, dataset_name):
        bad = [r[field] for r in rows if r[field] and r[field] not in student_id_set]
        if bad:
            errors.append(
                f"{dataset_name}: {len(bad)} rows reference invalid student_id(s), "
                f"e.g. {bad[:5]}"
            )

    check_fk(housing, "student_id", "housing.csv")
    check_fk(campus_safety, "student_id", "campus_safety.csv")
    check_fk(academic_integrity, "student_id", "academic_integrity.csv")
    check_fk(reports, "reported_student_id", "reports.csv")

    if errors:
        print("VERIFICATION FAILED:")
        for e in errors:
            print(f"  - {e}")
        raise SystemExit(1)

    return student_id_set


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main():
    ensure_output_dir()

    print(f"Generating synthetic data for fictional institution: {UNIVERSITY_NAME}")
    print("=" * 70)

    students, student_ids = generate_students()
    housing = generate_housing(student_ids)
    campus_safety = generate_campus_safety(student_ids)
    academic_integrity = generate_academic_integrity(student_ids)
    reports = generate_reports(student_ids)

    verify(students, housing, campus_safety, academic_integrity, reports)

    student_fields = [
        "student_id", "first_name", "last_name", "email", "dob", "major",
        "academic_year", "enrollment_status", "advisor", "phone", "address",
        "enrollment_date",
    ]
    housing_fields = [
        "housing_id", "student_id", "residence_hall", "room_number",
        "move_in_date", "move_out_date", "housing_status",
    ]
    safety_fields = [
        "report_id", "student_id", "incident_date", "location",
        "incident_type", "severity", "status", "narrative",
    ]
    integrity_fields = [
        "case_id", "student_id", "course_code", "course_name", "faculty_name",
        "incident_date", "violation_type", "severity", "status", "description",
    ]
    reports_fields = [
        "report_id", "reported_student_id", "reporter_type", "submitted_date",
        "category", "location", "priority", "description", "anonymous",
    ]

    write_csv("students.csv", student_fields, students)
    write_csv("housing.csv", housing_fields, housing)
    write_csv("campus_safety.csv", safety_fields, campus_safety)
    write_csv("academic_integrity.csv", integrity_fields, academic_integrity)
    write_csv("reports.csv", reports_fields, reports)

    # ---------------------------------------------------------------
    # Summary
    # ---------------------------------------------------------------
    students_with_housing = len({r["student_id"] for r in housing})
    students_with_safety = len({r["student_id"] for r in campus_safety})
    students_with_integrity = len({r["student_id"] for r in academic_integrity})
    students_with_reports = len({r["reported_student_id"] for r in reports if r["reported_student_id"]})

    any_incident_students = (
        {r["student_id"] for r in campus_safety}
        | {r["student_id"] for r in academic_integrity}
        | {r["reported_student_id"] for r in reports if r["reported_student_id"]}
    )

    students_multiple_safety = sum(
        1 for sid in set(r["student_id"] for r in campus_safety)
        if sum(1 for r in campus_safety if r["student_id"] == sid) > 1
    )

    print("\nSUMMARY")
    print("=" * 70)
    print(f"students.csv            : {len(students):>6} records (unique IDs: {len(set(student_ids))})")
    print(f"housing.csv             : {len(housing):>6} records ({students_with_housing} distinct students housed)")
    print(f"campus_safety.csv       : {len(campus_safety):>6} records ({students_with_safety} distinct students involved)")
    print(f"academic_integrity.csv  : {len(academic_integrity):>6} records ({students_with_integrity} distinct students involved)")
    print(f"reports.csv             : {len(reports):>6} records ({students_with_reports} distinct students named; "
          f"{len(reports) - sum(1 for r in reports if r['reported_student_id'])} with no identified student)")
    print("-" * 70)
    print(f"Students with ANY incident (safety/integrity/named report): {len(any_incident_students)} "
          f"({len(any_incident_students) / NUM_STUDENTS:.1%} of student body)")
    print(f"Students with ZERO incidents on record: {NUM_STUDENTS - len(any_incident_students)} "
          f"({(NUM_STUDENTS - len(any_incident_students)) / NUM_STUDENTS:.1%})")
    print(f"Students with multiple campus safety reports: {students_multiple_safety}")
    print("=" * 70)
    print("All relational integrity checks passed: every foreign-key student_id")
    print("in housing/campus_safety/academic_integrity/reports exists in students.csv.")
    print(f"\nFiles written to: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
