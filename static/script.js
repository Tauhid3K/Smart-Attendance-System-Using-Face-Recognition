document.addEventListener("DOMContentLoaded", function () {
  const API_BASE_URL = window.location.origin;
  let livePollInterval = null;
  const MAX_STUDENT_IMAGES = 5;

  const studentMediaState = {
    uploadImages: [],
    cameraImages: [],
    cameraStream: null,
    faceDetector: null,
    faceDetectionTimer: null,
    faceVisible: false,
  };

  // ============================================
  // PAGE NAVIGATION SYSTEM
  // ============================================
  const sections = {
    dashboard: document.getElementById('dashboard-section'),
    students: document.getElementById('students-section'),
    attendance: document.getElementById('attendance-section'),
    records: document.getElementById('records-section')
  };
  
  const navLinks = {
    dashboard: document.getElementById('nav-dashboard'),
    students: document.getElementById('nav-students'),
    attendance: document.getElementById('nav-attendance'),
    records: document.getElementById('nav-records')
  };
  
  const pageTitles = {
    dashboard: ['Dashboard', 'Welcome to your attendance control center.'],
    students: ['Manage Students', 'Register, update, and manage student face profiles.'],
    attendance: ['Live Attendance Tracker', 'Perform automated attendance using face recognition.'],
    records: ['Attendance Records', 'Review history, search student logs, and export reports.']
  };
  
  function showPage(page) {
    Object.keys(sections).forEach(key => {
      if (sections[key]) sections[key].style.display = 'none';
    });
    
    if (sections[page]) {
      sections[page].style.display = 'block';
    }
    
    Object.keys(navLinks).forEach(key => {
      if (navLinks[key]) navLinks[key].classList.remove('active');
    });
    if (navLinks[page]) {
      navLinks[page].classList.add('active');
    }
    
    if (pageTitles[page]) {
      const titleEl = document.getElementById('page-title');
      const subtitleEl = document.getElementById('page-subtitle');
      if (titleEl) titleEl.textContent = pageTitles[page][0];
      if (subtitleEl) subtitleEl.textContent = pageTitles[page][1];
    }
    
    if (page === 'dashboard') loadDashboardStats();
    if (page === 'students') loadStudentsList();
    if (page === 'attendance') {
      if (typeof fetchLiveStatus === 'function') fetchLiveStatus();
    }
    if (page === 'records') loadRecordsList();
  }
  
  // Navigation click handlers
  Object.keys(navLinks).forEach(key => {
    if (navLinks[key]) {
      navLinks[key].addEventListener('click', function(e) {
        e.preventDefault();
        showPage(key);
        window.history.pushState({page: key}, '', '/' + key);
      });
    }
  });
  
  window.addEventListener('popstate', function(e) {
    if (e.state && e.state.page) {
      showPage(e.state.page);
    }
  });
  
  // Quick action buttons
  const btnQuickStart = document.getElementById('btn-quick-start');
  const btnQuickAdd = document.getElementById('btn-quick-add');
  const btnQuickRecords = document.getElementById('btn-quick-records');
  
  if (btnQuickStart) btnQuickStart.addEventListener('click', () => showPage('attendance'));
  if (btnQuickAdd) btnQuickAdd.addEventListener('click', () => showPage('students'));
  if (btnQuickRecords) btnQuickRecords.addEventListener('click', () => showPage('records'));

  // --- Common Elements: Toast Notifications ---
  function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    
    let icon = "fa-circle-info";
    if (type === "success") icon = "fa-circle-check";
    if (type === "error") icon = "fa-circle-xmark";

    toast.innerHTML = `
      <i class="fa-solid ${icon}"></i>
      <span>${message}</span>
    `;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = "slideUp 0.3s reverse forwards";
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 3000);
  }

  // --- Page Checkers ---
  const isDashboard = document.getElementById("recent-activity-list") !== null;
  const isStudents = document.getElementById("student-form") !== null;
  const isAttendance = document.getElementById("video-feed-img") !== null;
  const isRecords = document.getElementById("records-table-body") !== null;

  // --- 1. Dashboard View Controller ---
  function loadDashboardStats() {
    const statTotalStudents = document.getElementById("stat-total-students");
    const statPresentToday = document.getElementById("stat-present-today");
    const statAbsentToday = document.getElementById("stat-absent-today");
    const recentActivityList = document.getElementById("recent-activity-list");

    fetch(`${API_BASE_URL}/api/stats`)
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "success") {
          if (statTotalStudents) statTotalStudents.textContent = data.total_students;
          if (statPresentToday) statPresentToday.textContent = data.present_today;
          if (statAbsentToday) statAbsentToday.textContent = data.absent_today;

          if (recentActivityList) {
            recentActivityList.innerHTML = "";
            if (data.recent_activity.length === 0) {
              recentActivityList.innerHTML = `<li class="no-data-item">No recent activity logged for today.</li>`;
            } else {
              data.recent_activity.forEach((act) => {
                const li = document.createElement("li");
                li.className = "activity-item";
                li.innerHTML = `
                  <div class="activity-info">
                    <span class="activity-time">${act.time}</span>
                    <span class="activity-name">${act.name}</span>
                  </div>
                  <span class="activity-status present"><i class="fa-solid fa-check"></i> Present</span>
                `;
                recentActivityList.appendChild(li);
              });
            }
          }
        }
      })
      .catch((err) => {
        console.error(err);
        showToast("Error loading stats.", "error");
      });
  }

  // --- 2. Student Management View Controller ---
  function getTotalStudentImages() {
    return studentMediaState.uploadImages.length + studentMediaState.cameraImages.length;
  }

  function getImageLabel(index) {
    const labels = ["front", "left", "right", "angle-4", "angle-5"];
    return labels[index] || `photo-${index + 1}`;
  }

  function getStudentPhotoList(student) {
    if (!student) return [];
    if (student.face_images) {
      return student.face_images.split(",").map((item) => item.trim()).filter(Boolean);
    }
    if (student.photo_path) return [student.photo_path];
    return [];
  }

  function updateImageCounters() {
    const totalImages = getTotalStudentImages();
    const uploadCounter = document.getElementById("upload-photo-counter");
    const cameraCounter = document.getElementById("camera-photo-counter");
    if (uploadCounter) uploadCounter.textContent = `${totalImages}/5 photos selected`;
    if (cameraCounter) cameraCounter.textContent = `${totalImages}/5 photos captured`;
  }

  function renderUploadThumbnails() {
    const grid = document.getElementById("upload-preview-grid");
    if (!grid) return;

    grid.innerHTML = "";
    studentMediaState.uploadImages.forEach((image, index) => {
      const card = document.createElement("div");
      card.className = "thumbnail-card";
      card.innerHTML = `
        <button type="button" class="thumbnail-remove" data-source="upload" data-index="${index}">×</button>
        <img src="${image.previewUrl}" alt="Upload preview ${index + 1}" />
        <div class="thumb-label">${image.name}</div>
      `;
      grid.appendChild(card);
    });

    grid.querySelectorAll(".thumbnail-remove[data-source='upload']").forEach((button) => {
      button.addEventListener("click", function () {
        removeCapturedImage(Number(this.getAttribute("data-index")), "upload");
      });
    });
  }

  function renderCameraThumbnails() {
    const grid = document.getElementById("camera-preview-grid");
    if (!grid) return;

    grid.innerHTML = "";
    studentMediaState.cameraImages.forEach((image, index) => {
      const card = document.createElement("div");
      card.className = "thumbnail-card";
      card.innerHTML = `
        <button type="button" class="thumbnail-remove" data-source="camera" data-index="${index}">×</button>
        <img src="${image.previewUrl}" alt="Camera capture ${index + 1}" />
        <div class="thumb-label">${image.name}</div>
      `;
      grid.appendChild(card);
    });

    grid.querySelectorAll(".thumbnail-remove[data-source='camera']").forEach((button) => {
      button.addEventListener("click", function () {
        removeCapturedImage(Number(this.getAttribute("data-index")), "camera");
      });
    });
  }

  function updateFaceIndicator(isVisible, message) {
    const indicator = document.getElementById("camera-face-indicator");
    const statusDot = document.getElementById("camera-status-dot");
    const statusText = document.getElementById("student-camera-status-text");
    studentMediaState.faceVisible = isVisible;
    if (indicator) indicator.classList.toggle("face-visible", isVisible);
    if (statusDot) {
      statusDot.classList.remove("on", "idle");
      statusDot.classList.add(isVisible ? "on" : "idle");
    }
    if (statusText) statusText.textContent = message || (isVisible ? "Face detected" : "Camera ready");
  }

  function stopCamera() {
    if (studentMediaState.faceDetectionTimer) {
      clearInterval(studentMediaState.faceDetectionTimer);
      studentMediaState.faceDetectionTimer = null;
    }
    if (studentMediaState.cameraStream) {
      studentMediaState.cameraStream.getTracks().forEach((track) => track.stop());
      studentMediaState.cameraStream = null;
    }

    const video = document.getElementById("camera-video");
    if (video) video.srcObject = null;

    updateFaceIndicator(false, "Camera stopped");

    const startButton = document.getElementById("student-btn-start-camera");
    const stopButton = document.getElementById("student-btn-stop-camera");
    const captureButton = document.getElementById("student-btn-capture-photo");
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    if (captureButton) captureButton.disabled = true;
  }

  async function startCamera() {
    const video = document.getElementById("camera-video");
    const startButton = document.getElementById("student-btn-start-camera");
    const stopButton = document.getElementById("student-btn-stop-camera");
    const captureButton = document.getElementById("student-btn-capture-photo");

    if (!video) {
        console.error("Video element not found!");
        showToast("Camera element not found!", "error");
        return;
    }

    try {
        console.log("📷 Requesting camera access...");
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: "user",
                width: { ideal: 640 },
                height: { ideal: 480 }
            }, 
            audio: false 
        });
        
        studentMediaState.cameraStream = stream;
        video.srcObject = stream;
        await video.play();
        
        console.log("✅ Camera started successfully!");

        if (startButton) startButton.disabled = true;
        if (stopButton) stopButton.disabled = false;
        if (captureButton) captureButton.disabled = false;

        // Show the camera is active
        const statusText = document.getElementById("student-camera-status-text");
        if (statusText) statusText.textContent = "Camera active - Face detection running";

        updateFaceIndicator(false, "Scanning for a face...");
        detectFace();
        studentMediaState.faceDetectionTimer = setInterval(detectFace, 350);
        
        showToast("Camera started! Show your face for detection.", "success");
        
    } catch (error) {
        console.error("❌ Camera error:", error);
        showToast("Camera access was denied or unavailable. Please allow camera access.", "error");
        
        if (startButton) startButton.disabled = false;
    }
}

  function drawFaceBoxes(faces, width, height) {
    const overlay = document.getElementById("camera-overlay-canvas");
    if (!overlay) return;

    overlay.width = width;
    overlay.height = height;

    const context = overlay.getContext("2d");
    context.clearRect(0, 0, width, height);
    context.lineWidth = 3;
    context.strokeStyle = "#22c55e";
    context.fillStyle = "rgba(34, 197, 94, 0.15)";

    faces.forEach((face) => {
      const box = face.boundingBox || face;
      const x = box.x ?? box.left ?? 0;
      const y = box.y ?? box.top ?? 0;
      const w = box.width ?? (box.right ? box.right - x : 0);
      const h = box.height ?? (box.bottom ? box.bottom - y : 0);
      context.fillRect(x, y, w, h);
      context.strokeRect(x, y, w, h);
    });
  }

  async function detectFace() {
    const video = document.getElementById("camera-video");
    const captureCanvas = document.getElementById("camera-capture-canvas");
    if (!video || !captureCanvas || video.readyState < 2) {
      updateFaceIndicator(false, studentMediaState.cameraStream ? "Waiting for camera feed..." : "Camera idle");
      return;
    }

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    captureCanvas.width = width;
    captureCanvas.height = height;

    const context = captureCanvas.getContext("2d");
    context.drawImage(video, 0, 0, width, height);

    if (!window.FaceDetector) {
      updateFaceIndicator(true, "Camera active");
      drawFaceBoxes([{ boundingBox: { x: 20, y: 20, width: width - 40, height: height - 40 } }], width, height);
      return;
    }

    if (!studentMediaState.faceDetector) {
      studentMediaState.faceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
    }

    try {
      const faces = await studentMediaState.faceDetector.detect(captureCanvas);
      const hasFace = Array.isArray(faces) && faces.length > 0;
      updateFaceIndicator(hasFace, hasFace ? "Face detected" : "No face detected");
      drawFaceBoxes(faces, width, height);
    } catch (error) {
      console.error(error);
      updateFaceIndicator(false, "Face detection unavailable");
      drawFaceBoxes([], width, height);
    }
  }

  async function capturePhoto() {
    const video = document.getElementById("camera-video");
    const captureCanvas = document.getElementById("camera-capture-canvas");
    if (!video || !captureCanvas) return;

    if (!studentMediaState.faceVisible) {
      showToast("Move closer until a face is detected, then capture.", "error");
      return;
    }

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    captureCanvas.width = width;
    captureCanvas.height = height;

    const context = captureCanvas.getContext("2d");
    context.drawImage(video, 0, 0, width, height);
    const base64 = captureCanvas.toDataURL("image/png", 0.95);

    if (addCapturedImage(base64)) {
      showToast("Photo captured successfully.", "success");
    }
  }

  function addCapturedImage(base64) {
    if (getTotalStudentImages() >= 5) {
      showToast("You can only keep up to 5 photos.", "info");
      return false;
    }

    studentMediaState.cameraImages.push({
      name: getImageLabel(getTotalStudentImages()),
      previewUrl: base64,
      base64,
    });
    renderCameraThumbnails();
    updateImageCounters();
    return true;
  }

  function removeCapturedImage(index, source = "camera") {
    const collection = source === "upload" ? studentMediaState.uploadImages : studentMediaState.cameraImages;
    if (!collection[index]) return;

    if (collection[index].objectUrl) {
      URL.revokeObjectURL(collection[index].objectUrl);
    }

    collection.splice(index, 1);
    renderUploadThumbnails();
    renderCameraThumbnails();
    updateImageCounters();
  }

  function uploadPhotos(files) {
    const incomingFiles = Array.from(files || []);
    if (!incomingFiles.length) return;

    const availableSlots = 5 - getTotalStudentImages();
    if (availableSlots <= 0) {
      showToast("Remove one photo before adding another.", "info");
      return;
    }

    incomingFiles.slice(0, availableSlots).forEach((file) => {
      const objectUrl = URL.createObjectURL(file);
      studentMediaState.uploadImages.push({
        name: getImageLabel(getTotalStudentImages()),
        file,
        previewUrl: objectUrl,
        objectUrl,
      });
    });

    renderUploadThumbnails();
    updateImageCounters();
  }

  function validateImages() {
    const totalImages = getTotalStudentImages();
    const editModeInput = document.getElementById("edit-mode");
    const isEditMode = editModeInput?.value === "true";

    if (isEditMode && totalImages === 0) return true;
    if (totalImages < 3) {
      showToast("Please add at least 3 photos before saving the student.", "error");
      return false;
    }
    return true;
  }

  function submitStudent() {
    const studentForm = document.getElementById("student-form");
    if (!studentForm) return;

    const editModeInput = document.getElementById("edit-mode");
    const studentIdInput = document.getElementById("student-id");
    const studentNameInput = document.getElementById("student-name");
    const studentCourseInput = document.getElementById("student-course");
    const studentYearInput = document.getElementById("student-year");
    const saveButton = document.getElementById("btn-save-student");
    const isEditMode = editModeInput?.value === "true";

    if (!validateImages()) return;

    const formData = new FormData();
    formData.append("id", studentIdInput.value.trim());
    formData.append("name", studentNameInput.value.trim());
    formData.append("course", studentCourseInput.value.trim());
    formData.append("year", studentYearInput.value.trim());
    formData.append("image_total", String(getTotalStudentImages()));

    studentMediaState.uploadImages.forEach((image) => {
      formData.append("photo_files[]", image.file, image.file.name);
    });

    studentMediaState.cameraImages.forEach((image) => {
      formData.append("camera_images[]", image.base64);
    });

    if (saveButton) saveButton.disabled = true;

    const endpoint = isEditMode ? `${API_BASE_URL}/api/students/${studentIdInput.value.trim()}` : `${API_BASE_URL}/api/add_student`;
    const method = isEditMode ? "PUT" : "POST";

    fetch(endpoint, { method, body: formData })
      .then((res) => res.json().then((payload) => ({ ok: res.ok, payload })))
      .then(({ ok, payload }) => {
        if (ok && payload.status === "success") {
          showToast(isEditMode ? "Student updated successfully." : "Student added successfully.", "success");
          resetStudentForm();
          loadStudentsList();
        } else {
          showToast(payload.error_message || "Unable to save student.", "error");
        }
      })
      .catch((error) => {
        console.error(error);
        showToast("Network error while saving the student.", "error");
      })
      .finally(() => {
        if (saveButton) saveButton.disabled = false;
      });
  }

  function setupStudentForm() {
    const studentForm = document.getElementById("student-form");
    const studentSearchInput = document.getElementById("student-search");
    const studentTableBody = document.getElementById("student-table-body");
    const uploadInput = document.getElementById("student-photo-input");
    const uploadZone = document.getElementById("upload-zone");
    const resetButton = document.getElementById("btn-reset-form");
    const startCameraButton = document.getElementById("student-btn-start-camera");
    const stopCameraButton = document.getElementById("student-btn-stop-camera");
    const captureButton = document.getElementById("student-btn-capture-photo");
    const tabButtons = document.querySelectorAll(".student-image-tab");

    tabButtons.forEach((button) => {
      button.addEventListener("click", function () {
        const target = this.getAttribute("data-tab-target");
        tabButtons.forEach((btn) => btn.classList.toggle("active", btn === this));
        document.querySelectorAll(".image-panel").forEach((panel) => {
          panel.classList.toggle("active", panel.id === target);
        });
      });
    });

    if (uploadInput) {
      uploadInput.addEventListener("change", function () {
        uploadPhotos(this.files);
        this.value = "";
      });
    }

    if (uploadZone) {
      uploadZone.addEventListener("dragover", function (event) {
        event.preventDefault();
      });
      uploadZone.addEventListener("drop", function (event) {
        event.preventDefault();
        uploadPhotos(event.dataTransfer.files);
      });
    }

    if (resetButton) resetButton.addEventListener("click", resetStudentForm);
    if (studentForm) studentForm.addEventListener("submit", function (event) {
      event.preventDefault();
      submitStudent();
    });
    if (startCameraButton) startCameraButton.addEventListener("click", startCamera);
    if (stopCameraButton) stopCameraButton.addEventListener("click", stopCamera);
    if (captureButton) captureButton.addEventListener("click", capturePhoto);

    if (studentSearchInput) {
      studentSearchInput.addEventListener("keyup", function () {
        const query = this.value.toLowerCase().trim();
        const rows = studentTableBody.querySelectorAll("tr");
        rows.forEach((row) => {
          const idText = row.cells[0].textContent.toLowerCase();
          const nameText = row.cells[1].textContent.toLowerCase();
          const courseText = row.cells[2].textContent.toLowerCase();
          row.style.display = (idText.includes(query) || nameText.includes(query) || courseText.includes(query)) ? "" : "none";
        });
      });
    }

    const btnExportStudents = document.getElementById("btn-export-students-csv");
    if (btnExportStudents) {
      btnExportStudents.addEventListener("click", () => {
        fetch(`${API_BASE_URL}/api/students`)
          .then((res) => res.json())
          .then((students) => {
            if (students.length === 0) {
              showToast("No students to export.", "info");
              return;
            }
            const headers = ["ID", "Name", "Course", "Year", "Photo Paths", "Embedding"];
            const rows = students.map((s) => [s.id, s.name, s.course, s.year, s.face_images || s.photo_path || "None", s.face_embedding ? "Stored" : "None"]);
            exportToCSV(rows, "student_list.csv", headers);
          });
      });
    }
  }

  function loadStudentsList() {
    const studentTableBody = document.getElementById("student-table-body");
    if (!studentTableBody) return;

    studentTableBody.innerHTML = `<tr><td colspan="6" class="loading-item">Loading students...</td></tr>`;

    fetch(`${API_BASE_URL}/api/students`)
      .then((res) => res.json())
      .then((students) => {
        studentTableBody.innerHTML = "";
        if (students.length === 0) {
          studentTableBody.innerHTML = `<tr><td colspan="6" class="no-data-item">No students registered yet.</td></tr>`;
          return;
        }

        students.forEach((s) => {
          const tr = document.createElement("tr");
          const photoList = getStudentPhotoList(s);
          const primaryPhoto = photoList[0];
          const photoCount = photoList.length;

          const photoCell = primaryPhoto
            ? `
              <div class="table-photo-cell">
                <img src="${API_BASE_URL}/uploads/faces/${encodeURI(primaryPhoto)}?t=${Date.now()}" alt="Face" />
                <span style="display:inline-block;margin-top:.35rem;padding:.15rem .45rem;border-radius:999px;background:rgba(59,130,246,.15);color:#93c5fd;font-size:.72rem;font-weight:700;">${photoCount} photo${photoCount === 1 ? "" : "s"}</span>
              </div>
            `
            : `<div class="table-photo-cell" style="background: rgba(239,68,68,0.1)"><i class="fa-solid fa-circle-xmark absent-icon"></i></div>`;

          tr.innerHTML = `
            <td><strong>${s.id}</strong></td>
            <td>${s.name}</td>
            <td>${s.course}</td>
            <td>${s.year}</td>
            <td>${photoCell}</td>
            <td>
              <div class="row-actions">
                <button class="btn-action edit-btn" data-id="${s.id}" title="✏️ Edit"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="btn-action delete-btn" data-id="${s.id}" title="🗑️ Delete"><i class="fa-solid fa-trash-can"></i></button>
              </div>
            </td>
          `;
          studentTableBody.appendChild(tr);
        });

        setupTableActionListeners(students);
      })
      .catch((err) => {
        console.error(err);
        studentTableBody.innerHTML = `<tr><td colspan="6" class="no-data-item" style="color:var(--danger)">Error fetching student list.</td></tr>`;
      });
  }

  function setupTableActionListeners(students) {
    const studentTableBody = document.getElementById("student-table-body");
    const editModeInput = document.getElementById("edit-mode");
    const studentIdInput = document.getElementById("student-id");
    const studentNameInput = document.getElementById("student-name");
    const studentCourseInput = document.getElementById("student-course");
    const studentYearInput = document.getElementById("student-year");
    const formHeaderTitle = document.getElementById("form-header-title");
    const supportNote = document.getElementById("camera-support-note");

    studentTableBody.querySelectorAll(".edit-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const id = this.getAttribute("data-id");
        const student = students.find((s) => s.id === id);
        if (student) {
          editModeInput.value = "true";
          studentIdInput.value = student.id;
          studentIdInput.disabled = true;
          studentNameInput.value = student.name;
          studentCourseInput.value = student.course;
          studentYearInput.value = student.year;

          studentMediaState.uploadImages = [];
          studentMediaState.cameraImages = [];
          renderUploadThumbnails();
          renderCameraThumbnails();
          updateImageCounters();

          formHeaderTitle.textContent = "✏️ Edit Student Profile";
          if (supportNote) {
            const images = getStudentPhotoList(student);
            supportNote.textContent = images.length > 0
              ? `This student already has ${images.length} stored photo${images.length === 1 ? "" : "s"}. Add new photos to replace them.`
              : "Add at least 3 photos to create a face profile.";
          }

          document.querySelector(".form-card").scrollIntoView({ behavior: "smooth" });
        }
      });
    });

    studentTableBody.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const id = this.getAttribute("data-id");
        if (confirm(`Are you sure you want to delete Student ID ${id}?`)) {
          fetch(`${API_BASE_URL}/api/students/${id}`, { method: "DELETE" })
            .then((res) => res.json())
            .then((data) => {
              if (data.status === "success") {
                showToast("Student profile deleted successfully.", "success");
                loadStudentsList();
              } else {
                showToast(data.error_message || "Delete failed", "error");
              }
            })
            .catch((err) => {
              console.error(err);
              showToast("Error deleting student profile.", "error");
            });
        }
      });
    });
  }

  function resetStudentForm() {
    const studentForm = document.getElementById("student-form");
    const editModeInput = document.getElementById("edit-mode");
    const studentIdInput = document.getElementById("student-id");
    const formHeaderTitle = document.getElementById("form-header-title");
    const supportNote = document.getElementById("camera-support-note");

    if (studentForm) {
      studentForm.reset();
      editModeInput.value = "false";
      studentIdInput.disabled = false;
      formHeaderTitle.textContent = "➕ Add New Student";

      studentMediaState.uploadImages.forEach((image) => {
        if (image.objectUrl) URL.revokeObjectURL(image.objectUrl);
      });
      studentMediaState.uploadImages = [];
      studentMediaState.cameraImages = [];
      renderUploadThumbnails();
      renderCameraThumbnails();
      updateImageCounters();
      stopCamera();

      if (supportNote) {
        supportNote.textContent = "Use Start Camera to begin live capture. Face detection appears in green when a face is visible.";
      }
    }
  }

  // --- 3. Live Attendance View Controller ---
  function setupCameraControls() {
    const btnStart = document.getElementById("btn-start-camera");
    const btnStop = document.getElementById("btn-stop-camera");
    const btnSaveStop = document.getElementById("btn-save-stop-camera");
    const btnReset = document.getElementById("btn-reset-session");

    if (btnStart) btnStart.addEventListener("click", startCameraCapture);
    if (btnStop) btnStop.addEventListener("click", () => stopCameraCapture(true));
    if (btnSaveStop) btnSaveStop.addEventListener("click", () => stopCameraCapture(true));
    if (btnReset) btnReset.addEventListener("click", resetLiveSessionStats);
  }

  function startCameraCapture() {
    const btnStart = document.getElementById("btn-start-camera");
    const btnStop = document.getElementById("btn-stop-camera");
    const btnSaveStop = document.getElementById("btn-save-stop-camera");
    const videoFeedImg = document.getElementById("video-feed-img");
    const videoFeedPlaceholder = document.getElementById("video-feed-placeholder");
    const cameraStatusBadge = document.getElementById("camera-status-badge");
    const cameraStatusText = document.getElementById("camera-status-text");

    if (!btnStart) {
        console.error("Start button not found!");
        showToast("Start button not found!", "error");
        return;
    }

    btnStart.disabled = true;
    btnStart.textContent = "⏳ Starting...";

    console.log("Starting camera...");

    fetch(`${API_BASE_URL}/api/live/start`, { 
        method: "POST",
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then((res) => {
        console.log("Response status:", res.status);
        return res.json();
    })
    .then((data) => {
        console.log("Response data:", data);
        
        if (data.status === "success") {
            showToast("Camera feed active. Loading facial scanning filters...", "success");
            
            if (videoFeedPlaceholder) videoFeedPlaceholder.style.display = "none";
            if (videoFeedImg) {
                videoFeedImg.style.display = "block";
                videoFeedImg.src = `${API_BASE_URL}/video_feed?t=${Date.now()}`;
            }
            
            if (btnStop) btnStop.disabled = false;
            if (btnSaveStop) btnSaveStop.disabled = false;
            
            if (cameraStatusBadge) {
                const dot = cameraStatusBadge.querySelector(".status-dot");
                if (dot) dot.className = "status-dot online";
            }
            if (cameraStatusText) cameraStatusText.textContent = "Camera Ready";

            if (livePollInterval) clearInterval(livePollInterval);
            livePollInterval = setInterval(fetchLiveStatus, 1000);
            
            btnStart.textContent = "▶️ Start";
        } else {
            showToast(data.error_message || "Camera start failed", "error");
            btnStart.disabled = false;
            btnStart.textContent = "▶️ Start";
        }
    })
    .catch((err) => {
        console.error("Error starting camera:", err);
        showToast("Error connecting to webcam API.", "error");
        btnStart.disabled = false;
        btnStart.textContent = "▶️ Start";
    });
  }

  function stopCameraCapture(saveSession = true) {
    if (livePollInterval) {
      clearInterval(livePollInterval);
      livePollInterval = null;
    }

    fetch(`${API_BASE_URL}/api/live/stop`, { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "success") {
          if (saveSession) {
            showToast("Session stopped. Attendance written to database & CSV backup.", "success");
          }
          resetCameraViewport();
          fetchLiveStatus();
        }
      })
      .catch((err) => {
        console.error(err);
        resetCameraViewport();
      });
  }

  function resetCameraViewport() {
    const btnStart = document.getElementById("btn-start-camera");
    const btnStop = document.getElementById("btn-stop-camera");
    const btnSaveStop = document.getElementById("btn-save-stop-camera");
    const videoFeedImg = document.getElementById("video-feed-img");
    const videoFeedPlaceholder = document.getElementById("video-feed-placeholder");
    const cameraStatusBadge = document.getElementById("camera-status-badge");
    const cameraStatusText = document.getElementById("camera-status-text");
    const countDetected = document.getElementById("count-detected");
    const countRecognized = document.getElementById("count-recognized");
    const countUnknown = document.getElementById("count-unknown");

    if (videoFeedImg) {
      videoFeedImg.src = "";
      videoFeedImg.style.display = "none";
    }
    if (videoFeedPlaceholder) videoFeedPlaceholder.style.display = "flex";

    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
    if (btnSaveStop) btnSaveStop.disabled = true;

    if (cameraStatusBadge) {
      const dot = cameraStatusBadge.querySelector(".status-dot");
      if (dot) dot.className = "status-dot offline";
    }
    if (cameraStatusText) cameraStatusText.textContent = "Camera Off";

    if (countDetected) countDetected.textContent = "0";
    if (countRecognized) countRecognized.textContent = "0";
    if (countUnknown) countUnknown.textContent = "0";
  }

  function resetLiveSessionStats() {
    if (confirm("Reset current session attendance counters?")) {
      fetch(`${API_BASE_URL}/api/live/reset`, { method: "POST" })
        .then((res) => res.json())
        .then((data) => {
          if (data.status === "success") {
            showToast("Temporary session stats cleared.", "info");
            fetchLiveStatus();
          }
        });
    }
  }

  function fetchLiveStatus() {
    const countDetected = document.getElementById("count-detected");
    const countRecognized = document.getElementById("count-recognized");
    const countUnknown = document.getElementById("count-unknown");
    const liveAttendanceList = document.getElementById("live-attendance-list");
    const liveListSummary = document.getElementById("live-list-summary");

    fetch(`${API_BASE_URL}/api/live/status`)
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "success") {
          if (countDetected) countDetected.textContent = data.faces_detected;
          if (countRecognized) countRecognized.textContent = data.recognized_count;
          if (countUnknown) countUnknown.textContent = data.unknown_count;

          if (liveAttendanceList) {
            liveAttendanceList.innerHTML = "";
            let totalStudentsCount = data.total_students;
            let presentCount = 0;

            if (data.attendance_list.length === 0) {
              liveAttendanceList.innerHTML = `<li class="loading-item">No students in record.</li>`;
            } else {
              data.attendance_list.forEach((item) => {
                const li = document.createElement("li");
                const isPresent = item.status === "Present";
                if (isPresent) presentCount++;

                li.className = `live-student-item ${isPresent ? "present" : "absent"}`;
                
                const badgeIcon = isPresent ? "fa-circle-check" : "fa-circle-xmark";
                const badgeClass = isPresent ? "present-badge" : "absent-badge";

                li.innerHTML = `
                  <div class="live-student-info">
                    <span class="live-student-name">${item.name}</span>
                    <span class="live-student-id">ID: ${item.id}</span>
                  </div>
                  <div style="text-align: right;">
                    <span class="live-student-status ${badgeClass}">
                      <i class="fa-solid ${badgeIcon}"></i> ${item.status}
                    </span>
                    ${isPresent ? `<span class="live-student-time">${item.time}</span>` : ""}
                  </div>
                `;
                liveAttendanceList.appendChild(li);
              });
            }

            if (liveListSummary) {
              liveListSummary.textContent = `Total: ${presentCount}/${totalStudentsCount}`;
            }
          }
        }
      })
      .catch((err) => {
        console.error("Live status fetch error:", err);
      });
  }

  // --- 4. Records Filter View Controller ---
  function setupRecordsFilters() {
    const filterDate = document.getElementById("filter-date");
    const filterSearch = document.getElementById("filter-search");
    const btnApply = document.getElementById("btn-apply-filters");
    const btnReset = document.getElementById("btn-reset-filters");
    const btnExport = document.getElementById("btn-export-records-csv");

    if (btnApply) btnApply.addEventListener("click", loadRecordsList);
    
    if (btnReset) {
      btnReset.addEventListener("click", function () {
        if (filterDate) filterDate.value = new Date().toISOString().split("T")[0];
        if (filterSearch) filterSearch.value = "";
        loadRecordsList();
      });
    }

    if (btnExport) {
      btnExport.addEventListener("click", () => {
        const dateVal = filterDate ? filterDate.value : "";
        const searchVal = filterSearch ? filterSearch.value.trim() : "";

        fetch(`${API_BASE_URL}/api/attendance?date=${dateVal}&search=${searchVal}`)
          .then((res) => res.json())
          .then((data) => {
            if (data.status === "success" && data.records.length > 0) {
              const headers = ["#", "Date", "Student Name", "Check-in Time", "Attendance Status"];
              const rows = data.records.map((r) => [r.index, r.date, r.name, r.time, r.status]);
              exportToCSV(rows, `attendance_records_${dateVal || 'all'}.csv`, headers);
            } else {
              showToast("No filtered records to export.", "info");
            }
          });
      });
    }
  }

  function loadRecordsList() {
    const recordsTableBody = document.getElementById("records-table-body");
    const recordsTotalCount = document.getElementById("records-total-count");
    const filterDate = document.getElementById("filter-date");
    const filterSearch = document.getElementById("filter-search");

    if (!recordsTableBody) return;

    recordsTableBody.innerHTML = `<tr><td colspan="5" class="loading-item">Loading records...</td></tr>`;

    const dateVal = filterDate ? filterDate.value : "";
    const searchVal = filterSearch ? filterSearch.value.trim() : "";

    fetch(`${API_BASE_URL}/api/attendance?date=${dateVal}&search=${searchVal}`)
      .then((res) => res.json())
      .then((data) => {
        recordsTableBody.innerHTML = "";
        if (data.status === "success") {
          const records = data.records;
          
          if (records.length === 0) {
            recordsTableBody.innerHTML = `<tr><td colspan="5" class="no-data-item">No attendance logs found matching conditions.</td></tr>`;
            if (recordsTotalCount) recordsTotalCount.textContent = "Total Records: 0";
            return;
          }

          records.forEach((r) => {
            const tr = document.createElement("tr");
            const isPresent = r.status === "Present";
            const badgeClass = isPresent ? "present" : "absent";
            const statusIcon = isPresent ? "fa-circle-check" : "fa-circle-xmark";

            tr.innerHTML = `
              <td>${r.index}</td>
              <td>${r.date}</td>
              <td><strong>${r.name}</strong></td>
              <td>${r.time}</td>
              <td>
                <span class="status-cell-badge ${badgeClass}">
                  <i class="fa-solid ${statusIcon}"></i> ${r.status}
                </span>
              </td>
            `;
            recordsTableBody.appendChild(tr);
          });

          if (recordsTotalCount) recordsTotalCount.textContent = `Total Records: ${records.length}`;
        }
      })
      .catch((err) => {
        console.error(err);
        recordsTableBody.innerHTML = `<tr><td colspan="5" class="no-data-item" style="color:var(--danger)">Error loading records.</td></tr>`;
      });
  }

  // --- Helper: CSV Exporter ---
  function exportToCSV(dataRows, filename, headers = null) {
    let csvContent = "data:text/csv;charset=utf-8,";
    
    if (headers) {
      csvContent += headers.join(",") + "\n";
    }

    dataRows.forEach((row) => {
      const escapedRow = row.map((cell) => {
        const stringVal = String(cell);
        if (stringVal.includes(",") || stringVal.includes("\n")) {
          return `"${stringVal.replace(/"/g, '""')}"`;
        }
        return stringVal;
      });
      csvContent += escapedRow.join(",") + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`CSV file "${filename}" downloaded successfully.`, "success");
  }

  // ============================================
  // INITIALIZE PAGE
  // ============================================
  const defaultPage = 'dashboard';
  showPage(defaultPage);

  if (isStudents) {
    setupStudentForm();
  }
  if (isAttendance) {
    setupCameraControls();
    fetchLiveStatus();
  }
  if (isRecords) {
    setupRecordsFilters();
  }

}); // END OF DOMContentLoaded