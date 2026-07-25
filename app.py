# attendance_system/app.py

from flask import Flask, render_template, request, jsonify, Response, send_from_directory
from flask_cors import CORS
import base64
import binascii
import os
import json
import shutil
import time
from datetime import datetime
import logging

import numpy as np
import face_recognition
from deepface import DeepFace

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Import local modules
try:
    from . import database
    from .face_camera import camera
except ImportError:
    import database
    from face_camera import camera

app = Flask(__name__)
CORS(app)

# Configure directories
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads', 'faces')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Initialize database on boot
database.init_db()

ALLOWED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}

# --- Single Page Route ---
@app.route('/')
def index():
    """Serve the single index page"""
    return render_template('index.html')

# --- Serving Uploaded Images ---
@app.route('/uploads/faces/<path:filename>')
def serve_face_image(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# --- Student Management REST APIs ---
@app.route('/api/students', methods=['GET'])
def api_list_students():
    students = database.get_all_students()
    return jsonify(students)

def _student_folder(student_id):
    return os.path.join(app.config['UPLOAD_FOLDER'], student_id)

def _relative_face_path(student_id, filename):
    return os.path.join(student_id, filename).replace('\\', '/')

def _decode_data_url(data_url):
    if not data_url or ',' not in data_url:
        raise ValueError('Invalid camera image payload')

    header, encoded = data_url.split(',', 1)
    try:
        image_bytes = base64.b64decode(encoded)
    except (ValueError, binascii.Error) as exc:
        raise ValueError('Invalid base64 image payload') from exc

    ext = '.png'
    if 'image/jpeg' in header:
        ext = '.jpg'
    elif 'image/webp' in header:
        ext = '.webp'

    return image_bytes, ext

def _extract_embedding(image_path):
    """Extract face embedding using DeepFace with fallback to face_recognition"""
    
    # Try DeepFace first (better accuracy)
    try:
        result = DeepFace.represent(
            img_path=image_path,
            model_name='Facenet512',
            enforce_detection=False,
            detector_backend='opencv'
        )
        
        if isinstance(result, list) and result:
            result = result[0]
        if isinstance(result, dict) and 'embedding' in result:
            return np.asarray(result['embedding'], dtype=np.float32)
            
    except Exception as e:
        logger.warning(f"DeepFace embedding failed: {e}")
    
    # Fallback to face_recognition
    try:
        image = face_recognition.load_image_file(image_path)
        encodings = face_recognition.face_encodings(image)
        if encodings:
            return np.asarray(encodings[0], dtype=np.float32)
    except Exception as e:
        logger.warning(f"face_recognition embedding failed: {e}")
    
    return None

def _normalize_embedding(embedding_vectors):
    if not embedding_vectors:
        return None

    stacked = np.vstack(embedding_vectors)
    averaged = stacked.mean(axis=0)
    norm = np.linalg.norm(averaged)
    if norm > 0:
      averaged = averaged / norm
    return averaged.astype(float).tolist()

def _collect_student_media(student_id, uploaded_files, camera_payloads):
    student_dir = _student_folder(student_id)
    os.makedirs(student_dir, exist_ok=True)

    stored_relative_paths = []
    embeddings = []
    image_index = 0

    uploads = [item for item in uploaded_files if item and item.filename]
    cameras = [item for item in camera_payloads if item]
    combined_items = [('upload', item) for item in uploads] + [('camera', item) for item in cameras]

    if len(combined_items) > 5:
        raise ValueError('A maximum of 5 photos is allowed')

    for source, item in combined_items:
        label = ['front', 'left', 'right', 'angle-4', 'angle-5'][image_index] if image_index < 5 else f'photo-{image_index + 1}'

        if source == 'upload':
            original_ext = os.path.splitext(item.filename)[1].lower()
            ext = original_ext if original_ext in ALLOWED_IMAGE_EXTENSIONS else '.jpg'
            filename = f'{label}{ext}'
            absolute_path = os.path.join(student_dir, filename)
            item.save(absolute_path)
        else:
            image_bytes, ext = _decode_data_url(item)
            filename = f'{label}{ext}'
            absolute_path = os.path.join(student_dir, filename)
            with open(absolute_path, 'wb') as image_file:
                image_file.write(image_bytes)

        embedding = _extract_embedding(absolute_path)
        if embedding is not None:
            embeddings.append(embedding)

        stored_relative_paths.append(_relative_face_path(student_id, filename))
        image_index += 1

    if len(stored_relative_paths) < 3:
        raise ValueError('Please provide at least 3 photos')

    averaged_embedding = _normalize_embedding(embeddings)
    if averaged_embedding is None:
        raise ValueError('No detectable face found in the uploaded images')

    return stored_relative_paths, averaged_embedding

def _delete_student_folder(student_id):
    student_dir = _student_folder(student_id)
    if os.path.exists(student_dir):
        shutil.rmtree(student_dir, ignore_errors=True)

def _camera_images_from_request():
    camera_images = request.form.getlist('camera_images[]')
    if not camera_images and request.form.get('camera_image'):
        camera_images = [request.form.get('camera_image')]
    return camera_images

def _save_student_submission(student_id, name, course, year, is_update=False):
    try:
        if not student_id or not name or not course or not year:
            return jsonify({'status': 'error', 'error_message': 'Missing required fields'}), 400

        uploaded_files = request.files.getlist('photo_files[]')
        if not uploaded_files and 'photo' in request.files:
            uploaded_files = [request.files['photo']]

        camera_images = _camera_images_from_request()

        existing_student = database.get_student(student_id) if is_update else None
        has_new_media = any(file_item and file_item.filename for file_item in uploaded_files) or len(camera_images) > 0

        if not is_update and not has_new_media:
            return jsonify({'status': 'error', 'error_message': 'At least 3 photos are required'}), 400

        if is_update and not has_new_media:
            success, msg = database.update_student(student_id, name, course, year)
            if success:
                if camera.is_running:
                    camera.load_known_faces()
                return jsonify({'status': 'success', 'message': msg})
            return jsonify({'status': 'error', 'error_message': msg}), 400

        if len([file_item for file_item in uploaded_files if file_item and file_item.filename]) + len(camera_images) < 3:
            return jsonify({'status': 'error', 'error_message': 'Please provide at least 3 photos'}), 400

        if is_update:
            _delete_student_folder(student_id)

        stored_paths, averaged_embedding = _collect_student_media(student_id, uploaded_files, camera_images)
        primary_photo = stored_paths[0] if stored_paths else None
        face_images = ','.join(stored_paths)
        face_embedding = json.dumps(averaged_embedding)

        if is_update:
            success, msg = database.update_student(
                student_id,
                name,
                course,
                year,
                photo_path=primary_photo,
                face_images=face_images,
                face_embedding=face_embedding,
            )
        else:
            success, msg = database.add_student(
                student_id,
                name,
                course,
                year,
                photo_path=primary_photo,
                face_images=face_images,
                face_embedding=face_embedding,
            )

        if success:
            if camera.is_running:
                camera.load_known_faces()
            return jsonify({'status': 'success', 'message': msg})

        _delete_student_folder(student_id)
        return jsonify({'status': 'error', 'error_message': msg}), 400
    except Exception as e:
        _delete_student_folder(student_id)
        return jsonify({'status': 'error', 'error_message': str(e)}), 500

@app.route('/api/add_student', methods=['POST'])
def api_add_student():
    student_id = request.form.get('id')
    name = request.form.get('name')
    course = request.form.get('course')
    year = request.form.get('year')
    return _save_student_submission(student_id, name, course, year, is_update=False)

@app.route('/api/students/<student_id>', methods=['PUT'])
def api_edit_student(student_id):
    try:
        student = database.get_student(student_id)
        if not student:
            return jsonify({'status': 'error', 'error_message': 'Student not found'}), 404

        name = request.form.get('name')
        course = request.form.get('course')
        year = request.form.get('year')

        return _save_student_submission(student_id, name, course, year, is_update=True)
    except Exception as e:
        return jsonify({'status': 'error', 'error_message': str(e)}), 500

@app.route('/api/students/<student_id>', methods=['DELETE'])
def api_delete_student(student_id):
    try:
        success, result = database.delete_student(student_id)
        if success:
            _delete_student_folder(student_id)
            if camera.is_running:
                camera.load_known_faces()
            return jsonify({'status': 'success', 'message': 'Student deleted successfully'})
        else:
            return jsonify({'status': 'error', 'error_message': result}), 400
    except Exception as e:
        return jsonify({'status': 'error', 'error_message': str(e)}), 500

# --- Dashboard Stats API ---
@app.route('/api/stats', methods=['GET'])
def api_get_stats():
    try:
        students = database.get_all_students()
        total_students = len(students)
        
        today_str = datetime.today().strftime('%Y-%m-%d')
        
        conn = database.get_db_connection()
        present_count = conn.execute(
            'SELECT COUNT(*) FROM attendance WHERE date = ?', (today_str,)
        ).fetchone()[0]
        
        recent_rows = conn.execute('''
            SELECT s.name, a.time, a.date
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            ORDER BY a.id DESC LIMIT 5
        ''').fetchall()
        conn.close()
        
        recent_activities = []
        for r in recent_rows:
            t_parsed = datetime.strptime(r['time'], '%H:%M:%S')
            t_formatted = t_parsed.strftime('%I:%M %p')
            recent_activities.append({
                'time': t_formatted,
                'name': r['name'],
                'status': 'Present'
            })
            
        absent_count = max(0, total_students - present_count)
        
        return jsonify({
            'status': 'success',
            'total_students': total_students,
            'present_today': present_count,
            'absent_today': absent_count,
            'recent_activity': recent_activities
        })
    except Exception as e:
        return jsonify({'status': 'error', 'error_message': str(e)}), 500

# --- Attendance Records Query API ---
@app.route('/api/attendance', methods=['GET'])
def api_query_attendance():
    try:
        date_filter = request.args.get('date')
        search_query = request.args.get('search', '')
        
        records = database.get_attendance_records(date_filter, search_query)
        return jsonify({'status': 'success', 'records': records})
    except Exception as e:
        return jsonify({'status': 'error', 'error_message': str(e)}), 500

# --- Webcam Live Video Session APIs ---
@app.route('/api/live/start', methods=['GET', 'POST'])  # ← Add GET here
def api_start_camera():
    success = camera.start()
    if success:
        return jsonify({'status': 'success', 'message': 'Camera session started'})
    else:
        return jsonify({'status': 'error', 'error_message': 'Failed to initialize webcam'}), 500

@app.route('/api/live/stop', methods=['GET', 'POST']) 
def api_stop_camera():
    camera.save_session_to_database()
    camera.stop()
    return jsonify({'status': 'success', 'message': 'Camera session stopped and logged'})

@app.route('/api/live/reset', methods=['POST'])
def api_reset_camera_session():
    camera.reset_session()
    return jsonify({'status': 'success', 'message': 'Active session counters reset'})

@app.route('/api/live/status', methods=['GET'])
def api_get_live_status():
    students = database.get_all_students()
    
    attendance_list = []
    for s in students:
        is_detected = s['id'] in camera.session_attendance
        attendance_list.append({
            'id': s['id'],
            'name': s['name'],
            'status': 'Present' if is_detected else 'Absent',
            'time': camera.session_attendance[s['id']] if is_detected else '-'
        })
        
    return jsonify({
        'status': 'success',
        'is_running': camera.is_running,
        'faces_detected': camera.faces_detected,
        'recognized_count': len(camera.session_attendance),
        'unknown_count': camera.unknown_faces,
        'attendance_list': attendance_list,
        'total_students': len(students)
    })

# Generator function for streaming video
def gen_frames():
    while True:
        if not camera.is_running or camera.last_frame is None:
            time.sleep(0.1)
            continue
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + camera.last_frame + b'\r\n')
        time.sleep(0.04)

@app.route('/video_feed')
def video_feed():
    return Response(gen_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)