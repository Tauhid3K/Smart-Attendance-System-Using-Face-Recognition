import cv2
import numpy as np
import threading
import uuid
import time
import os
import json
import base64
import winsound
from datetime import datetime
import logging
from deepface import DeepFace

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    from . import database
except ImportError:
    import database

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

class CameraStream:
    def __init__(self):
        self.cap = None
        self.is_running = False
        self.thread = None
        self.lock = threading.Lock()
        
        # Known faces storage
        self.known_faces = []  # List of (student_id, name, embedding)
        
        # Session stats
        self.faces_detected = 0
        self.recognized_names = set()
        self.unknown_faces = 0
        self.session_attendance = {}  # student_id -> check-in time
        self.last_frame = None
        self.frame_count = 0

    def load_known_faces(self):
        """Load all known faces from database using DeepFace"""
        self.known_faces = []
        
        students = database.get_all_students()
        logger.info(f"Loading {len(students)} students for face recognition")
        
        for student in students:
            # Get the first photo path
            photo_paths = []
            if student.get('face_images'):
                photo_paths = [p.strip() for p in student['face_images'].split(',') if p.strip()]
            elif student.get('photo_path'):
                photo_paths = [student['photo_path']]
            
            if not photo_paths:
                continue
            
            # Try to load embedding from database first
            embedding = None
            if student.get('face_embedding'):
                try:
                    embedding = json.loads(student['face_embedding'])
                    logger.info(f"Loaded stored embedding for {student['name']}")
                except Exception as e:
                    logger.warning(f"Error loading embedding for {student['name']}: {e}")
            
            # If no stored embedding, generate from first photo
            if embedding is None and photo_paths:
                # Build absolute path
                rel_path = photo_paths[0]
                if os.path.isabs(rel_path):
                    abs_path = rel_path
                else:
                    abs_path = os.path.join(BASE_DIR, 'uploads', 'faces', rel_path)
                
                if os.path.exists(abs_path):
                    try:
                        logger.info(f"Generating embedding for {student['name']} from {abs_path}")
                        result = DeepFace.represent(
                            img_path=abs_path,
                            model_name='Facenet512',
                            enforce_detection=False,
                            detector_backend='opencv'
                        )
                        if result and isinstance(result, list) and len(result) > 0:
                            embedding = result[0]['embedding']
                            logger.info(f"Generated embedding for {student['name']}")
                    except Exception as e:
                        logger.warning(f"Error generating embedding for {student['name']}: {e}")
            
            if embedding is not None:
                self.known_faces.append({
                    'student_id': student['id'],
                    'name': student['name'],
                    'embedding': embedding
                })
                logger.info(f"Loaded face for {student['name']}")
        
        logger.info(f"Successfully loaded {len(self.known_faces)} face encodings")

    def start(self):
        with self.lock:
            if self.is_running:
                return True
            
            self.load_known_faces()
            
            # Try different camera backends
            self.cap = None
            backends = [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_V4L2, cv2.CAP_ANY]
            
            for backend in backends:
                try:
                    cap = cv2.VideoCapture(0, backend)
                    if cap.isOpened():
                        self.cap = cap
                        logger.info(f"Camera opened with backend: {backend}")
                        break
                except:
                    continue
            
            if not self.cap or not self.cap.isOpened():
                logger.error("Failed to open camera")
                return False
                
            # Set camera properties
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.cap.set(cv2.CAP_PROP_FPS, 30)
                
            self.is_running = True
            self.faces_detected = 0
            self.recognized_names = set()
            self.unknown_faces = 0
            self.session_attendance = {}
            self.last_frame = None
            self.frame_count = 0
            
            self.thread = threading.Thread(target=self._capture_loop)
            self.thread.daemon = True
            self.thread.start()
            logger.info("Camera started successfully")
            return True

    def stop(self):
        with self.lock:
            if not self.is_running:
                return
            self.is_running = False
        if self.thread:
            self.thread.join(timeout=2.0)
            self.thread = None
        if self.cap:
            self.cap.release()
            self.cap = None
        logger.info("Camera stopped")

    def save_session_to_database(self, session_meta=None):
        if not self.session_attendance:
            logger.info("No session attendance to save.")
            return
        
        meta = session_meta or {}
        department = meta.get('department')
        semester = meta.get('semester')
        year = meta.get('year')
        subject = meta.get('subject')
        instructor = meta.get('instructor')
        class_name = meta.get('class_name')
        section = meta.get('section')
        session_id = meta.get('session_id') or uuid.uuid4().hex

        today_str = datetime.today().strftime('%Y-%m-%d')
        for student_id, time_str in self.session_attendance.items():
            database.log_attendance(
                student_id, today_str, time_str,
                department=department, semester=semester, year=year,
                subject=subject, instructor=instructor, session_id=session_id,
                class_name=class_name, section=section
            )
        
        logger.info(f"Saved {len(self.session_attendance)} attendance records")
        self.session_attendance.clear()

    def reset_session(self):
        with self.lock:
            self.session_attendance.clear()
            self.recognized_names.clear()
            self.faces_detected = 0
            self.unknown_faces = 0

    def _save_frame_for_debug(self, frame, name):
        """Save frame for debugging (optional)"""
        try:
            timestamp = datetime.now().strftime('%H%M%S')
            filename = f"debug_{name}_{timestamp}.jpg"
            path = os.path.join(BASE_DIR, 'debug_frames')
            os.makedirs(path, exist_ok=True)
            cv2.imwrite(os.path.join(path, filename), frame)
        except:
            pass

    # Cosine similarity above which a detected face is considered a match to a
    # known student. Set to 0.70 (70%) for ultra high-confidence precision matching.
    MATCH_THRESHOLD = 0.70

    def _capture_loop(self):
        """Main capture loop: detect faces, recognize known students, and mark attendance."""
        last_rec_time = 0
        # Faces found in the most recent recognition pass, used to draw boxes
        # on every streamed frame until the next recognition pass replaces them.
        current_faces = []

        while True:
            with self.lock:
                if not self.is_running:
                    break

            success, frame = self.cap.read()
            if not success:
                time.sleep(0.01)
                continue

            self.frame_count += 1

            # Process every 3rd frame, throttled to ~3x/second, to save CPU
            if self.frame_count % 3 == 0:
                current_time = time.time()

                if current_time - last_rec_time > 0.3:
                    last_rec_time = current_time
                    current_faces = []
                    frame_recognized = 0
                    frame_unknown = 0

                    try:
                        # Detect every face in the frame and get its embedding directly
                        # (no need to round-trip through a temp file on disk).
                        representations = DeepFace.represent(
                            img_path=frame,
                            model_name='Facenet512',
                            enforce_detection=False,
                            detector_backend='opencv'
                        )

                        for rep in representations or []:
                            if not isinstance(rep, dict) or 'embedding' not in rep:
                                continue

                            face_encoding = np.asarray(rep['embedding'], dtype=np.float32)
                            area = rep.get('facial_area') or {}
                            box = (
                                int(area.get('x', 0)),
                                int(area.get('y', 0)),
                                int(area.get('w', frame.shape[1] // 3)),
                                int(area.get('h', frame.shape[0] // 3)),
                            )

                            best_name = "Unknown"
                            best_student_id = None
                            best_similarity = 0.0

                            for known_face in self.known_faces:
                                known_embedding = np.asarray(known_face['embedding'], dtype=np.float32)
                                denom = np.linalg.norm(known_embedding) * np.linalg.norm(face_encoding)
                                if denom == 0:
                                    continue
                                similarity = float(np.dot(known_embedding, face_encoding) / denom)
                                if similarity > best_similarity:
                                    best_similarity = similarity
                                    if similarity >= self.MATCH_THRESHOLD:
                                        best_name = known_face['name']
                                        best_student_id = known_face['student_id']

                            if best_student_id:
                                frame_recognized += 1
                                match_pct = int(best_similarity * 100)
                                if best_student_id not in self.session_attendance:
                                    self.session_attendance[best_student_id] = datetime.now().strftime('%H:%M:%S')
                                    logger.info(f"✅ {best_name} marked present at {self.session_attendance[best_student_id]} ({match_pct}% match)")
                                self.recognized_names.add(best_name)
                                display_label = f"{best_name} ({match_pct}%)"
                            else:
                                frame_unknown += 1
                                display_label = "Unknown"

                            current_faces.append({
                                'name': display_label,
                                'box': box,
                                'known': best_student_id is not None,
                            })

                    except Exception as e:
                        logger.debug(f"Face recognition error: {e}")

                    # Reflect the current frame's counts (not an ever-growing total)
                    self.faces_detected = frame_recognized + frame_unknown
                    self.unknown_faces = frame_unknown

            # Draw bounding boxes and names from the most recent recognition pass
            for face in current_faces:
                x, y, w, h = face['box']
                color = (46, 213, 115) if face['known'] else (255, 71, 87)
                cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
                label_w = max(w, 90)
                cv2.rectangle(frame, (x, max(0, y - 28)), (x + label_w, y), color, cv2.FILLED)
                cv2.putText(frame, face['name'], (x + 6, max(14, y - 8)),
                           cv2.FONT_HERSHEY_DUPLEX, 0.6, (255, 255, 255), 1)

            # Encode frame to JPEG
            ret, jpeg = cv2.imencode('.jpg', frame)
            if ret:
                self.last_frame = jpeg.tobytes()

            time.sleep(0.03)  # Cap stream at ~30 FPS

camera = CameraStream()

import face_recognition

class GuidedEnrollmentStream:
    # 10 guided angles — total photos captured = 10, well within the 20-photo limit
    POSES = [
        {'key': 'front_neutral',    'title': 'FRONT — NEUTRAL',   'prompt': 'Look straight at the camera with a neutral expression'},
        {'key': 'front_smiling',    'title': 'FRONT — SMILING',    'prompt': 'Look straight at the camera and smile naturally'},
        {'key': 'slight_left',      'title': 'SLIGHT LEFT',        'prompt': 'Turn your head slightly to the left'},
        {'key': 'slight_right',     'title': 'SLIGHT RIGHT',       'prompt': 'Turn your head slightly to the right'},
        {'key': 'medium_left',      'title': 'MEDIUM LEFT',        'prompt': 'Turn your head moderately to the left'},
        {'key': 'medium_right',     'title': 'MEDIUM RIGHT',       'prompt': 'Turn your head moderately to the right'},
        {'key': 'tilt_up',          'title': 'SLIGHTLY UPWARD',    'prompt': 'Tilt your chin slightly upward'},
        {'key': 'tilt_down',        'title': 'SLIGHTLY DOWNWARD',  'prompt': 'Tilt your chin slightly downward'},
        {'key': 'head_tilt_left',   'title': 'HEAD TILTED LEFT',   'prompt': 'Tilt your head (ear toward left shoulder)'},
        {'key': 'head_tilt_right',  'title': 'HEAD TILTED RIGHT',  'prompt': 'Tilt your head (ear toward right shoulder)'},
    ]

    def __init__(self):
        self.cap = None
        self.is_running = False
        self.thread = None
        self.lock = threading.Lock()
        
        self.student_info = {}
        self.current_step = 0
        self.stable_frames = 0
        self.captured_poses = {}
        self.embeddings = []
        self.is_completed = False
        self.status_message = "Ready for OpenCV guided video enrollment"
        self.last_frame = None
        self.last_capture_time = 0
        # Manual capture flag: set via trigger_manual_capture(), cleared after each use
        self.manual_capture_requested = False

    def start(self, student_id, name, course, year, semester=None, is_update=False):
        with self.lock:
            if self.is_running:
                self.stop_internal()
            
            self.student_info = {
                'student_id': str(student_id).strip(),
                'name': str(name).strip(),
                'course': str(course).strip(),
                'year': str(year).strip(),
                'semester': str(semester).strip() if semester else None,
                'is_update': is_update
            }
            self.current_step = 0
            self.stable_frames = 0
            self.captured_poses = {}
            self.embeddings = []
            self.is_completed = False
            self.status_message = f"Step 1/{len(self.POSES)}: {self.POSES[0]['prompt']} for {name}"
            self.last_capture_time = 0
            self.manual_capture_requested = False

            # Pause main attendance camera if running to share camera resource
            if camera.is_running:
                camera.stop()

            # Open camera
            self.cap = None
            backends = [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_V4L2, cv2.CAP_ANY]
            for backend in backends:
                try:
                    cap = cv2.VideoCapture(0, backend)
                    if cap.isOpened():
                        self.cap = cap
                        break
                except:
                    continue

            if not self.cap or not self.cap.isOpened():
                self.status_message = "Error opening OpenCV camera"
                return False

            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.cap.set(cv2.CAP_PROP_FPS, 30)

            self.is_running = True
            self.thread = threading.Thread(target=self._enrollment_loop)
            self.thread.daemon = True
            self.thread.start()
            logger.info(f"OpenCV guided enrollment started for {name} ({student_id})")
            return True

    def stop_internal(self):
        self.is_running = False
        if self.cap:
            self.cap.release()
            self.cap = None

    def stop(self):
        with self.lock:
            self.stop_internal()
            self.status_message = "Enrollment stopped"

    def get_status(self):
        with self.lock:
            return {
                'active': self.is_running,
                'completed': self.is_completed,
                'current_step': self.current_step,
                'total_steps': len(self.POSES),
                'message': self.status_message,
                'captured_poses': self.captured_poses,
                'student_info': self.student_info,
                'manual_capture_pending': self.manual_capture_requested,
            }

    def get_frame(self):
        with self.lock:
            return self.last_frame

    def trigger_manual_capture(self):
        """Request an immediate capture on the next frame that has a face."""
        with self.lock:
            if not self.is_running or self.is_completed:
                return False
            if self.current_step >= len(self.POSES):
                return False
            self.manual_capture_requested = True
            return True

    def _enrollment_loop(self):
        HOLD_SECONDS = 5.0  # seconds face must be visible before capture
        POSE_WAIT = 2.0     # seconds to show instruction before starting countdown

        pose_start_time = time.time() + POSE_WAIT  # give first pose some settle time
        face_stable_since = None
        showing_countdown = False

        while True:
            with self.lock:
                if not self.is_running:
                    break

            success, frame = self.cap.read()
            if not success:
                time.sleep(0.02)
                continue

            h, w, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

            target_pose = self.POSES[self.current_step] if self.current_step < len(self.POSES) else None
            face_box = None
            now = time.time()

            if target_pose and not self.is_completed and now >= pose_start_time:
                # Detect face (only every other frame for performance)
                face_locations = face_recognition.face_locations(rgb_frame, model='hog')
                if face_locations:
                    face_box = face_locations[0]
                    if face_stable_since is None:
                        face_stable_since = now

                    elapsed = now - face_stable_since
                    remaining = max(0.0, HOLD_SECONDS - elapsed)

                    # Check for manual capture request (overrides the hold timer)
                    with self.lock:
                        do_manual = self.manual_capture_requested
                        if do_manual:
                            self.manual_capture_requested = False

                    if do_manual or elapsed >= HOLD_SECONDS:
                        # Capture! (manual or auto)
                        self._capture_current_pose(frame, face_box, target_pose['key'])
                        self.current_step += 1
                        face_stable_since = None
                        pose_start_time = now + POSE_WAIT

                        if self.current_step >= len(self.POSES):
                            self._finish_and_save()
                        else:
                            next_p = self.POSES[self.current_step]
                            self.status_message = f"Step {self.current_step + 1}/{len(self.POSES)}: {next_p['prompt']}"
                    else:
                        self.status_message = f"Step {self.current_step + 1}/{len(self.POSES)} — Hold still... {remaining:.1f}s"
                else:
                    # No face detected — clear any pending manual request
                    with self.lock:
                        self.manual_capture_requested = False
                    face_stable_since = None
                    if target_pose:
                        self.status_message = f"Step {self.current_step + 1}/{len(self.POSES)}: {target_pose['prompt']}"
            elif target_pose and not self.is_completed:
                self.status_message = f"Get ready: {target_pose['title']}"

            # Render HUD
            self._render_hud(frame, target_pose, face_box, face_stable_since, HOLD_SECONDS)

            ret, jpeg = cv2.imencode('.jpg', frame)
            if ret:
                with self.lock:
                    self.last_frame = jpeg.tobytes()

            time.sleep(0.03)


    def _play_sound(self, frequency, duration_ms):
        """Play a beep on a daemon thread so it never blocks the capture loop."""
        t = threading.Thread(target=winsound.Beep, args=(frequency, duration_ms), daemon=True)
        t.start()

    def _capture_current_pose(self, frame, face_box, pose_key):
        # 🔔 Short crisp chime on every successful angle capture
        self._play_sound(880, 120)   # A5 note, 120 ms
        student_id = self.student_info['student_id']
        student_dir = os.path.join(BASE_DIR, 'uploads', 'faces', student_id)
        os.makedirs(student_dir, exist_ok=True)

        filename = f"{pose_key}.jpg"
        abs_path = os.path.join(student_dir, filename)

        if face_box:
            top, right, bottom, left = face_box
            h, w, _ = frame.shape
            margin_h = int((bottom - top) * 0.25)
            margin_w = int((right - left) * 0.25)
            y1 = max(0, top - margin_h)
            y2 = min(h, bottom + margin_h)
            x1 = max(0, left - margin_w)
            x2 = min(w, right + margin_w)
            cropped = frame[y1:y2, x1:x2]
            cv2.imwrite(abs_path, cropped)
        else:
            cv2.imwrite(abs_path, frame)

        rel_path = f"{student_id}/{filename}".replace('\\', '/')
        self.captured_poses[pose_key] = rel_path

        try:
            result = DeepFace.represent(
                img_path=abs_path,
                model_name='Facenet512',
                enforce_detection=False,
                detector_backend='opencv'
            )
            if result and isinstance(result, list) and len(result) > 0:
                emb = np.asarray(result[0]['embedding'], dtype=np.float32)
                self.embeddings.append(emb)
        except Exception as e:
            logger.warning(f"Embedding extraction failed for {pose_key}: {e}")

    def _finish_and_save(self):
        try:
            student_id = self.student_info['student_id']
            name = self.student_info['name']
            course = self.student_info['course']
            year = self.student_info['year']
            is_update = self.student_info.get('is_update', False)

            stored_paths = [self.captured_poses[p['key']] for p in self.POSES if p['key'] in self.captured_poses]
            primary_photo = stored_paths[0] if stored_paths else None
            face_images = ','.join(stored_paths)

            averaged_emb = None
            if self.embeddings:
                stacked = np.vstack(self.embeddings)
                avg = stacked.mean(axis=0)
                norm = np.linalg.norm(avg)
                if norm > 0:
                    avg = avg / norm
                averaged_emb = avg.astype(float).tolist()

            face_embedding_json = json.dumps(averaged_emb) if averaged_emb is not None else None

            semester = self.student_info.get('semester')
            if is_update:
                success, msg = database.update_student(
                    student_id, name, course, year,
                    semester=semester,
                    photo_path=primary_photo,
                    face_images=face_images,
                    face_embedding=face_embedding_json
                )
            else:
                success, msg = database.add_student(
                    student_id, name, course, year,
                    semester=semester,
                    photo_path=primary_photo,
                    face_images=face_images,
                    face_embedding=face_embedding_json
                )

            if success:
                self.is_completed = True
                self.status_message = f"🎉 Enrollment Complete for {name}! Trained {len(self.POSES)}-angle face embeddings."
                logger.info(f"OpenCV guided enrollment complete for {name} ({student_id})")
                # 🎵 Three-note ascending success melody
                def _success_melody():
                    for freq, dur in [(659, 120), (784, 120), (1047, 250)]:
                        winsound.Beep(freq, dur)
                        time.sleep(0.04)
                threading.Thread(target=_success_melody, daemon=True).start()
                if camera.is_running:
                    camera.load_known_faces()
            else:
                self.status_message = f"Error saving student: {msg}"
        except Exception as e:
            logger.error(f"Error finishing enrollment: {e}")
            self.status_message = f"Error: {e}"

    def _render_hud(self, frame, target_pose, face_box, face_stable_since, hold_seconds):
        h, w, _ = frame.shape
        now = time.time()
        cx, cy = w // 2, h // 2

        # ── 1. Dark navy border / background around the frame edges ──────────
        border = 14
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, h), (18, 24, 48), -1)
        cv2.addWeighted(overlay, 0.30, frame, 0.70, 0, frame)

        # ── 2. Large, soft white circle guide (like iOS face-ID ring) ─────────
        circle_r = int(min(w, h) * 0.38)
        cv2.circle(frame, (cx, cy), circle_r, (230, 230, 235), 2, cv2.LINE_AA)

        if self.is_completed:
            # Full green circle + centered text on completion
            cv2.circle(frame, (cx, cy), circle_r, (46, 213, 115), 4, cv2.LINE_AA)
            label = "SAVED!"
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_DUPLEX, 1.2, 2)
            cv2.putText(frame, label, (cx - tw // 2, cy + th // 2),
                        cv2.FONT_HERSHEY_DUPLEX, 1.2, (46, 213, 115), 2, cv2.LINE_AA)
        else:
            face_detected = face_box is not None

            # Countdown arc (blue) drawn OVER the white circle guide
            if face_detected and face_stable_since is not None:
                elapsed = now - face_stable_since
                progress = min(1.0, elapsed / hold_seconds)
                sweep = int(360 * progress)
                # Draw arc clockwise from top (-90°)
                cv2.ellipse(frame, (cx, cy), (circle_r, circle_r),
                            -90, 0, sweep, (56, 189, 248), 5, cv2.LINE_AA)

                # Remaining time label inside circle
                remaining = max(0.0, hold_seconds - elapsed)
                count_text = f"{remaining:.1f}s"
                (tw, th), _ = cv2.getTextSize(count_text, cv2.FONT_HERSHEY_DUPLEX, 0.9, 2)
                cv2.putText(frame, count_text, (cx - tw // 2, cy + th // 2),
                            cv2.FONT_HERSHEY_DUPLEX, 0.9, (56, 189, 248), 2, cv2.LINE_AA)

            # ── 3. Green ROUNDED face bounding box ───────────────────────────
            if face_box:
                top, right, bottom, left = face_box
                pad = 10
                x1, y1, x2, y2 = left - pad, top - pad, right + pad, bottom + pad
                thickness = 2
                radius = 16
                color_rect = (46, 213, 115)
                # Draw rounded rectangle using four arcs + four lines
                cv2.line(frame, (x1 + radius, y1), (x2 - radius, y1), color_rect, thickness, cv2.LINE_AA)
                cv2.line(frame, (x1 + radius, y2), (x2 - radius, y2), color_rect, thickness, cv2.LINE_AA)
                cv2.line(frame, (x1, y1 + radius), (x1, y2 - radius), color_rect, thickness, cv2.LINE_AA)
                cv2.line(frame, (x2, y1 + radius), (x2, y2 - radius), color_rect, thickness, cv2.LINE_AA)
                cv2.ellipse(frame, (x1 + radius, y1 + radius), (radius, radius), 180, 0, 90, color_rect, thickness, cv2.LINE_AA)
                cv2.ellipse(frame, (x2 - radius, y1 + radius), (radius, radius), 270, 0, 90, color_rect, thickness, cv2.LINE_AA)
                cv2.ellipse(frame, (x1 + radius, y2 - radius), (radius, radius),  90, 0, 90, color_rect, thickness, cv2.LINE_AA)
                cv2.ellipse(frame, (x2 - radius, y2 - radius), (radius, radius),   0, 0, 90, color_rect, thickness, cv2.LINE_AA)

guided_enrollment = GuidedEnrollmentStream()
