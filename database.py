import sqlite3
import os
import csv
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
    
    # Create attendance table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
            UNIQUE(student_id, date) -- One entry per student per day
        )
    ''')
    
    conn.commit()
    conn.close()
    
    # Create backup CSV file if not exists
    if not os.path.exists(CSV_PATH):
        with open(CSV_PATH, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['Name', 'Date', 'Time'])

def add_student(student_id, name, course, year, photo_path=None, face_images=None, face_embedding=None):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            'INSERT INTO students (id, name, course, year, photo_path, face_images, face_embedding) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (student_id, name, course, year, photo_path, face_images, face_embedding)
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

def update_student(student_id, name, course, year, photo_path=None, face_images=None, face_embedding=None):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        if photo_path is not None or face_images is not None or face_embedding is not None:
            cursor.execute(
                'UPDATE students SET name = ?, course = ?, year = ?, photo_path = ?, face_images = ?, face_embedding = ? WHERE id = ?',
                (name, course, year, photo_path, face_images, face_embedding, student_id)
            )
        else:
            cursor.execute(
                'UPDATE students SET name = ?, course = ?, year = ? WHERE id = ?',
                (name, course, year, student_id)
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

def log_attendance(student_id, date_str, time_str):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Fetch name first for CSV logging
        row = cursor.execute('SELECT name FROM students WHERE id = ?', (student_id,)).fetchone()
        if not row:
            return False, "Student not found"
        student_name = row['name']
        
        # Log to DB
        cursor.execute(
            'INSERT OR IGNORE INTO attendance (student_id, date, time) VALUES (?, ?, ?)',
            (student_id, date_str, time_str)
        )
        changes = conn.total_changes
        conn.commit()
        
        # If a new entry was inserted, append to backup CSV
        if changes > 0:
            with open(CSV_PATH, 'a', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                # Date format: convert YYYY-MM-DD or keep standard DD/MM/YYYY
                # For CSV consistency, let's convert YYYY-MM-DD to DD/MM/YYYY
                try:
                    dt = datetime.strptime(date_str, '%Y-%m-%d')
                    date_csv = dt.strftime('%d/%m/%Y')
                except ValueError:
                    date_csv = date_str
                writer.writerow([student_name, date_csv, time_str])
                
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

def get_attendance_records(date_filter=None, search_query=''):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    query = '''
        SELECT s.id, s.name, s.course, s.year, a.date, a.time,
               CASE WHEN a.date IS NOT NULL THEN 'Present' ELSE 'Absent' END as status
        FROM students s
        LEFT JOIN attendance a ON s.id = a.student_id AND a.date = ?
    '''
    
    # If date_filter is not provided, query all attendance entries
    if not date_filter:
        query = '''
            SELECT s.id, s.name, s.course, s.year, a.date, a.time,
                   'Present' as status
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            ORDER BY a.date DESC, a.time DESC
        '''
        params = ()
    else:
        params = (date_filter,)
        
    rows = cursor.execute(query, params).fetchall()
    conn.close()
    
    records = []
    for idx, row in enumerate(rows):
        r = dict(row)
        # Search filter
        if search_query:
            q = search_query.lower()
            if q not in r['name'].lower() and q not in r['id'].lower() and q not in r['course'].lower():
                continue
        
        # Standardize date formats to DD/MM/YYYY for UI display
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
            'year': r['year'],
            'date': disp_date,
            'time': r.get('time') or '-',
            'status': r['status']
        })
        
    return records
