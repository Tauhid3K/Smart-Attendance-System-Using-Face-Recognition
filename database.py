import sqlite3
import os
import csv
import uuid
from datetime import datetime

# Path setups
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.path.join(BASE_DIR, 'database')
os.makedirs(DB_DIR, exist_ok=True)

DB_PATH = os.path.join(DB_DIR, 'attendance.db')
CSV_PATH = os.path.join(BASE_DIR, 'attendance.csv')

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Create students table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS students (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            course TEXT NOT NULL,
            year TEXT NOT NULL,
            semester TEXT,
            photo_path TEXT,
            face_images TEXT,
            face_embedding TEXT
        )
    ''')

    # Backfill columns for existing installations
    existing_columns = {row['name'] for row in cursor.execute('PRAGMA table_info(students)').fetchall()}
    if 'photo_path' not in existing_columns:
        cursor.execute('ALTER TABLE students ADD COLUMN photo_path TEXT')
    if 'face_images' not in existing_columns:
        cursor.execute('ALTER TABLE students ADD COLUMN face_images TEXT')
    if 'face_embedding' not in existing_columns:
        cursor.execute('ALTER TABLE students ADD COLUMN face_embedding TEXT')
    if 'semester' not in existing_columns:
        cursor.execute('ALTER TABLE students ADD COLUMN semester TEXT')
    
    # Create attendance table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            department TEXT,
            semester TEXT,
            year TEXT,
            subject TEXT,
            instructor TEXT,
            class_name TEXT,
            section TEXT,
            session_id TEXT NOT NULL,
            FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
            UNIQUE(session_id, student_id)
        )
    ''')

    # Older versions used UNIQUE(student_id, date), which caused a second class
    # on the same day to overwrite the first class. Rebuild that table once so
    # every saved camera session has its own identifier.
    existing_att_cols = {row['name'] for row in cursor.execute('PRAGMA table_info(attendance)').fetchall()}
    attendance_sql_row = cursor.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attendance'"
    ).fetchone()
    attendance_sql = (attendance_sql_row['sql'] or '').replace(' ', '').lower() if attendance_sql_row else ''
    needs_session_migration = (
        'session_id' not in existing_att_cols
        or 'unique(student_id,date)' in attendance_sql
    )
    if needs_session_migration:
        cursor.execute('''
            CREATE TABLE attendance_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id TEXT NOT NULL,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                department TEXT,
                semester TEXT,
                year TEXT,
                subject TEXT,
                instructor TEXT,
                class_name TEXT,
                section TEXT,
                session_id TEXT NOT NULL,
                FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
                UNIQUE(session_id, student_id)
            )
        ''')
        columns = ['id', 'student_id', 'date', 'time', 'department', 'semester', 'year',
                   'subject', 'instructor', 'class_name', 'section', 'session_id']
        expressions = []
        for col in columns:
            if col == 'session_id':
                expressions.append("COALESCE(NULLIF(session_id, ''), 'legacy-' || id)" if col in existing_att_cols else "'legacy-' || id")
            elif col in existing_att_cols:
                expressions.append(col)
            else:
                expressions.append('NULL')
        cursor.execute(
            f"INSERT INTO attendance_new ({', '.join(columns)}) SELECT {', '.join(expressions)} FROM attendance"
        )
        cursor.execute('DROP TABLE attendance')
        cursor.execute('ALTER TABLE attendance_new RENAME TO attendance')
    else:
        for col in ['department', 'semester', 'year', 'subject', 'instructor', 'class_name', 'section']:
            if col not in existing_att_cols:
                cursor.execute(f'ALTER TABLE attendance ADD COLUMN {col} TEXT')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id)')
    
    conn.commit()
    conn.close()
    
    # Create backup CSV file if not exists
    if not os.path.exists(CSV_PATH):
        with open(CSV_PATH, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['Name', 'Date', 'Time', 'Department', 'Semester', 'Year', 'Subject', 'Instructor'])

def add_student(student_id, name, course, year, semester=None, photo_path=None, face_images=None, face_embedding=None):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            'INSERT INTO students (id, name, course, year, semester, photo_path, face_images, face_embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (student_id, name, course, year, semester, photo_path, face_images, face_embedding)
        )
        conn.commit()
        return True, "Student added successfully"
    except sqlite3.IntegrityError:
        return False, "Student ID already exists"
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()

def get_student(student_id):
    conn = get_db_connection()
    row = conn.execute('SELECT * FROM students WHERE id = ?', (student_id,)).fetchone()
    conn.close()
    return dict(row) if row else None

def get_all_students():
    conn = get_db_connection()
    rows = conn.execute('SELECT * FROM students ORDER BY id ASC').fetchall()
    conn.close()
    return [dict(r) for r in rows]

def update_student(student_id, name, course, year, semester=None, photo_path=None, face_images=None, face_embedding=None):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        if photo_path is not None or face_images is not None or face_embedding is not None:
            cursor.execute(
                'UPDATE students SET name = ?, course = ?, year = ?, semester = ?, photo_path = ?, face_images = ?, face_embedding = ? WHERE id = ?',
                (name, course, year, semester, photo_path, face_images, face_embedding, student_id)
            )
        else:
            cursor.execute(
                'UPDATE students SET name = ?, course = ?, year = ?, semester = ? WHERE id = ?',
                (name, course, year, semester, student_id)
            )
        conn.commit()
        return True, "Student updated successfully"
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()

def delete_student(student_id):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        row = cursor.execute('SELECT * FROM students WHERE id = ?', (student_id,)).fetchone()
        student = dict(row) if row else None
        
        cursor.execute('DELETE FROM students WHERE id = ?', (student_id,))
        conn.commit()
        return True, student
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()

def log_attendance(student_id, date_str, time_str, department=None, semester=None, year=None,
                   subject=None, instructor=None, session_id=None, class_name=None, section=None):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Fetch name first for CSV logging
        row = cursor.execute('SELECT name FROM students WHERE id = ?', (student_id,)).fetchone()
        if not row:
            return False, "Student not found"
        student_name = row['name']
        
        # A student can attend more than one class per day. The session id keeps
        # those class records separate while making a repeated save idempotent.
        session_id = session_id or uuid.uuid4().hex
        cursor.execute('''
            INSERT INTO attendance (student_id, date, time, department, semester, year, subject, instructor, class_name, section, session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, student_id) DO UPDATE SET
                time = excluded.time,
                department = excluded.department,
                semester = excluded.semester,
                year = excluded.year,
                subject = excluded.subject,
                instructor = excluded.instructor,
                class_name = excluded.class_name,
                section = excluded.section
        ''', (student_id, date_str, time_str, department, semester, year, subject, instructor,
              class_name, section, session_id))
        changes = conn.total_changes
        conn.commit()
        
        # If a new entry was inserted, append to backup CSV
        if changes > 0:
            with open(CSV_PATH, 'a', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                try:
                    dt = datetime.strptime(date_str, '%Y-%m-%d')
                    date_csv = dt.strftime('%d/%m/%Y')
                except ValueError:
                    date_csv = date_str
                writer.writerow([student_name, date_csv, time_str, department or '', semester or '', year or '', subject or '', instructor or ''])
                
        return True, "Attendance logged successfully"
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()

def clear_attendance_for_date(date_str):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('DELETE FROM attendance WHERE date = ?', (date_str,))
        conn.commit()
        
        # Rewrite backup CSV to remove today's logs
        try:
            dt = datetime.strptime(date_str, '%Y-%m-%d')
            date_csv = dt.strftime('%d/%m/%Y')
        except ValueError:
            date_csv = date_str
            
        remaining_rows = []
        if os.path.exists(CSV_PATH):
            with open(CSV_PATH, 'r', encoding='utf-8') as f:
                reader = csv.reader(f)
                header = next(reader, None)
                if header:
                    remaining_rows.append(header)
                    for row in reader:
                        if len(row) >= 2 and row[1] != date_csv:
                            remaining_rows.append(row)
            
            with open(CSV_PATH, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerows(remaining_rows)
                
        return True, "Attendance cleared"
    except Exception as e:
        return False, str(e)
    finally:
        conn.close()

def get_attendance_records(date_filter=None, date_to=None, search_query=''):
    conn = get_db_connection()
    cursor = conn.cursor()

    if date_filter and date_to:
        query = '''
            SELECT s.id, s.name, s.course, s.year AS student_year, a.year AS session_year, a.date, a.time,
                   a.department, a.semester, a.subject, a.instructor,
                   'Present' as status
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            WHERE a.date BETWEEN ? AND ?
            ORDER BY a.date DESC, a.time DESC
        '''
        params = (date_filter, date_to)
    elif date_filter:
        query = '''
            SELECT s.id, s.name, s.course, s.year AS student_year, a.year AS session_year, a.date, a.time,
                   a.department, a.semester, a.subject, a.instructor,
                   CASE WHEN a.date IS NOT NULL THEN 'Present' ELSE 'Absent' END as status
            FROM students s
            LEFT JOIN attendance a ON s.id = a.student_id AND a.date = ?
            ORDER BY status ASC, s.name ASC
        '''
        params = (date_filter,)
    else:
        query = '''
            SELECT s.id, s.name, s.course, s.year AS student_year, a.year AS session_year, a.date, a.time,
                   a.department, a.semester, a.subject, a.instructor,
                   'Present' as status
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            ORDER BY a.date DESC, a.time DESC
        '''
        params = ()

    rows = cursor.execute(query, params).fetchall()
    conn.close()

    records = []
    for idx, row in enumerate(rows):
        r = dict(row)
        if search_query:
            q = search_query.lower()
            if (q not in r['name'].lower() and q not in r['id'].lower() and q not in r['course'].lower()
                and q not in (r.get('department') or '').lower() and q not in (r.get('semester') or '').lower()
                and q not in (r.get('subject') or '').lower() and q not in (r.get('instructor') or '').lower()):
                continue

        disp_date = '-'
        if r.get('date'):
            try:
                dt = datetime.strptime(r['date'], '%Y-%m-%d')
                disp_date = dt.strftime('%d/%m/%Y')
            except ValueError:
                disp_date = r['date']

        records.append({
            'index': len(records) + 1,
            'id': r['id'],
            'name': r['name'],
            'course': r['course'],
            'year': r.get('session_year') or r.get('student_year') or r.get('course') or '-',
            'department': r.get('department') or r.get('course') or '-',
            'semester': r.get('semester') or '-',
            'subject': r.get('subject') or '-',
            'instructor': r.get('instructor') or '-',
            'date': disp_date,
            'time': r.get('time') or '-',
            'status': r['status']
        })

    return records


def get_unique_filters():
    """Get lists of unique subjects, departments, semesters, instructors for filter dropdowns."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    subjects = [row[0] for row in cursor.execute('SELECT DISTINCT subject FROM attendance WHERE subject IS NOT NULL AND subject != ""').fetchall()]
    departments = [row[0] for row in cursor.execute('SELECT DISTINCT department FROM attendance WHERE department IS NOT NULL AND department != ""').fetchall()]
    semesters = [row[0] for row in cursor.execute('SELECT DISTINCT semester FROM attendance WHERE semester IS NOT NULL AND semester != ""').fetchall()]
    instructors = [row[0] for row in cursor.execute('SELECT DISTINCT instructor FROM attendance WHERE instructor IS NOT NULL AND instructor != ""').fetchall()]
    
    conn.close()
    return {
        'subjects': sorted(subjects),
        'departments': sorted(departments),
        'semesters': sorted(semesters),
        'instructors': sorted(instructors)
    }


def get_subject_summary(date_filter=None, date_to=None):
    """Aggregate attendance summary grouped by Subject & Department & Semester."""
    conn = get_db_connection()
    cursor = conn.cursor()

    where_clause = ""
    params = []
    if date_filter and date_to:
        where_clause = "WHERE a.date BETWEEN ? AND ?"
        params = [date_filter, date_to]
    elif date_filter:
        where_clause = "WHERE a.date = ?"
        params = [date_filter]

    query = f'''
        SELECT 
            COALESCE(NULLIF(a.subject, ''), 'General') as subject,
            COALESCE(NULLIF(a.department, ''), 'CSE') as department,
            COALESCE(NULLIF(a.semester, ''), 'General') as semester,
            COALESCE(NULLIF(a.year, ''), '-') as year,
            COALESCE(NULLIF(a.instructor, ''), '-') as instructor,
            COUNT(DISTINCT a.date) as total_sessions,
            COUNT(a.id) as total_present_logs,
            COUNT(DISTINCT a.student_id) as unique_students
        FROM attendance a
        {where_clause}
        GROUP BY subject, department, semester, instructor
        ORDER BY total_present_logs DESC
    '''
    rows = cursor.execute(query, params).fetchall()
    
    total_enrolled = cursor.execute('SELECT COUNT(*) FROM students').fetchone()[0] or 1
    conn.close()

    summary = []
    for idx, row in enumerate(rows):
        r = dict(row)
        sessions = r['total_sessions'] or 1
        possible_attendances = total_enrolled * sessions
        rate = round((r['total_present_logs'] / max(1, possible_attendances)) * 100, 1)

        summary.append({
            'index': idx + 1,
            'subject': r['subject'],
            'department': r['department'],
            'semester': r['semester'],
            'year': r['year'],
            'instructor': r['instructor'],
            'total_sessions': r['total_sessions'],
            'total_present': r['total_present_logs'],
            'unique_students': r['unique_students'],
            'attendance_rate': min(100.0, rate)
        })

    return summary


def get_student_summary(date_filter=None, date_to=None):
    """Aggregate attendance performance metrics per student."""
    conn = get_db_connection()
    cursor = conn.cursor()

    where_clause = ""
    params = []
    if date_filter and date_to:
        where_clause = "AND a.date BETWEEN ? AND ?"
        params = [date_filter, date_to]
    elif date_filter:
        where_clause = "AND a.date = ?"
        params = [date_filter]

    # Total distinct active dates
    if date_filter and date_to:
        total_dates_count = cursor.execute('SELECT COUNT(DISTINCT date) FROM attendance WHERE date BETWEEN ? AND ?', (date_filter, date_to)).fetchone()[0]
    elif date_filter:
        total_dates_count = 1
    else:
        total_dates_count = cursor.execute('SELECT COUNT(DISTINCT date) FROM attendance').fetchone()[0]

    total_dates_count = max(1, total_dates_count or 1)

    query = f'''
        SELECT 
            s.id, s.name, s.course, s.year, s.semester,
            COUNT(a.id) as present_count,
            MAX(a.date) as last_date,
            MAX(a.time) as last_time
        FROM students s
        LEFT JOIN attendance a ON s.id = a.student_id {where_clause}
        GROUP BY s.id
        ORDER BY present_count DESC, s.name ASC
    '''
    rows = cursor.execute(query, params).fetchall()
    conn.close()

    students_summary = []
    for idx, row in enumerate(rows):
        r = dict(row)
        present = r['present_count'] or 0
        absent = max(0, total_dates_count - present)
        rate = round((present / total_dates_count) * 100, 1)

        disp_last_date = '-'
        if r.get('last_date'):
            try:
                dt = datetime.strptime(r['last_date'], '%Y-%m-%d')
                disp_last_date = dt.strftime('%d/%m/%Y')
            except ValueError:
                disp_last_date = r['last_date']

        students_summary.append({
            'index': idx + 1,
            'id': r['id'],
            'name': r['name'],
            'course': r['course'],
            'year': r['year'],
            'semester': r.get('semester') or '-',
            'present_count': present,
            'absent_count': absent,
            'total_days': total_dates_count,
            'attendance_rate': rate,
            'last_seen': f"{disp_last_date} ({r.get('last_time') or '-'})" if r.get('last_date') else 'Never'
        })

    return students_summary
