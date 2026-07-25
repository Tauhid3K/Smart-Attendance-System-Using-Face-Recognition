import cv2
import numpy as np
import threading
import time
import os
import json
import base64
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

    def save_session_to_database(self):
        if not self.session_attendance:
            return
        
        today_str = datetime.today().strftime('%Y-%m-%d')
        for student_id, time_str in self.session_attendance.items():
            database.log_attendance(student_id, today_str, time_str)
        
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
    # known student. Tune this up if you get false-positive matches, or down
    # if known students aren't being recognized.
    MATCH_THRESHOLD = 0.40

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
                                if best_student_id not in self.session_attendance:
                                    self.session_attendance[best_student_id] = datetime.now().strftime('%H:%M:%S')
                                    logger.info(f"✅ {best_name} marked present at {self.session_attendance[best_student_id]}")
                                self.recognized_names.add(best_name)
                            else:
                                frame_unknown += 1

                            current_faces.append({
                                'name': best_name,
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