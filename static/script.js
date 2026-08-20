document.addEventListener("DOMContentLoaded", function () {
  const API_BASE_URL = window.location.origin;
  let livePollInterval = null;
  const MAX_STUDENT_IMAGES = 20;

  const studentMediaState = {
    uploadImages: [],
    cameraImages: [],
    cameraStream: null,
    faceDetector: null,
    faceDetectionTimer: null,
    faceVisible: false,
    captureMode: "guided",
    guidedPoseIndex: 0,
    guidedStableFrames: 0,
    guidedLastCaptureAt: 0,
    guidedLastPoseCheckAt: 0,
    guidedCompleted: false,
  };

  const GUIDED_POSES = [
    { key: "front_neutral",   label: "Front — Neutral",   prompt: "Look straight at the camera with a neutral expression",      icon: "fa-user" },
    { key: "front_smiling",   label: "Front — Smiling",   prompt: "Look straight at the camera and smile naturally 😄",           icon: "fa-face-smile" },
    { key: "slight_left",     label: "Slight Left",        prompt: "Turn your head slightly to the left ⬅️",                    icon: "fa-arrow-left" },
    { key: "slight_right",    label: "Slight Right",       prompt: "Turn your head slightly to the right ➡️",                   icon: "fa-arrow-right" },
    { key: "medium_left",     label: "Medium Left",        prompt: "Turn your head moderately to the left ⬅️",                  icon: "fa-arrow-left" },
    { key: "medium_right",    label: "Medium Right",       prompt: "Turn your head moderately to the right ➡️",                 icon: "fa-arrow-right" },
    { key: "tilt_up",         label: "Tilt Up",            prompt: "Tilt your chin slightly upward ⬆️",                         icon: "fa-arrow-up" },
    { key: "tilt_down",       label: "Tilt Down",          prompt: "Tilt your chin slightly downward ⬇️",                       icon: "fa-arrow-down" },
    { key: "head_tilt_left",  label: "Head Tilt Left",     prompt: "Tilt head left — ear toward left shoulder 💈",              icon: "fa-rotate-left" },
    { key: "head_tilt_right", label: "Head Tilt Right",    prompt: "Tilt head right — ear toward right shoulder 💈",             icon: "fa-rotate-right" },
  ];

  function playSuccessChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {}
  }

  function playCompletionChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.08);
        gain.gain.setValueAtTime(0.15, ctx.currentTime + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.08 + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.08);
        osc.stop(ctx.currentTime + idx * 0.08 + 0.3);
      });
    } catch (e) {}
  }

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
      loadFilterOptions();
    }
    if (page === 'records') {
      loadAttendanceSummary('detailed');
      loadFilterOptions();
    }
  }
  
  // Navigation click handlers
  Object.keys(navLinks).forEach(key => {
    if (navLinks[key]) {
      navLinks[key].addEventListener('click', function(e) {
        e.preventDefault();
        showPage(key);
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

  // Export Data button
  const btnQuickExport = document.getElementById('btn-quick-export');
  if (btnQuickExport) {
    btnQuickExport.addEventListener('click', () => {
      const today = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      const displayDate = today.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

      const originalHTML = btnQuickExport.innerHTML;
      btnQuickExport.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Exporting...</span>';
      btnQuickExport.disabled = true;

      fetch(`${API_BASE_URL}/api/attendance?date=${todayStr}`)
        .then((res) => res.json())
        .then((data) => {
          btnQuickExport.innerHTML = originalHTML;
          btnQuickExport.disabled = false;

          if (data.status === 'success') {
            const presentRecords = data.records.filter((r) => r.status === 'Present');

            if (presentRecords.length === 0) {
              showToast(`No attendance records found for today (${displayDate}).`, 'info');
              return;
            }

            const groups = new Map();
            presentRecords.forEach((record) => {
              const details = {
                department: record.department || record.course || '-',
                year: record.year || '-',
                semester: record.semester || '-',
                subject: record.subject || '-',
                instructor: record.instructor || '-'
              };
              const key = JSON.stringify(details);
              if (!groups.has(key)) groups.set(key, { details, records: [] });
              groups.get(key).records.push(record);
            });

            const rows = [];
            const studentHeaders = ['#', 'Student ID', 'Student Name', 'Date', 'Check-in Time', 'Status'];
            [...groups.values()]
              .sort((a, b) => `${a.details.department}|${a.details.year}|${a.details.semester}|${a.details.subject}|${a.details.instructor}`
                .localeCompare(`${b.details.department}|${b.details.year}|${b.details.semester}|${b.details.subject}|${b.details.instructor}`))
              .forEach((group) => {
                const d = group.details;
                rows.push([`SESSION: Department: ${d.department} | Year: ${d.year} | Semester: ${d.semester} | Subject: ${d.subject} | Instructor: ${d.instructor}`]);
                rows.push([`Students Present: ${group.records.length}`]);
                rows.push(studentHeaders);
                group.records
                  .sort((a, b) => String(a.name).localeCompare(String(b.name)))
                  .forEach((record, index) => rows.push([
                    index + 1, record.id, record.name, record.date, record.time, record.status
                  ]));
                rows.push([]);
              });
            const filename = `attendance_${todayStr}.csv`;
            exportToCSV(rows, filename);
          } else {
            showToast('Failed to fetch attendance data.', 'error');
          }
        })
        .catch((err) => {
          console.error(err);
          btnQuickExport.innerHTML = originalHTML;
          btnQuickExport.disabled = false;
          showToast('Export failed. Please try again.', 'error');
        });
    });
  }

  // Auto-detect initial page from URL path
  (function initPageFromUrl() {
    const path = window.location.pathname.replace('/', '').toLowerCase();
    const validPages = ['dashboard', 'students', 'attendance', 'records'];
    const page = validPages.includes(path) ? path : 'dashboard';
    showPage(page);
  })();

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
                    ${act.detail ? `<span class="activity-detail" style="color:var(--text-secondary);font-size:0.85rem;">${act.detail}</span>` : ''}
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
    if (index < GUIDED_POSES.length) {
      return GUIDED_POSES[index].key;
    }
    return `photo-${index + 1}`;
  }

  function getGuidedPose() {
    return GUIDED_POSES[Math.min(studentMediaState.guidedPoseIndex, GUIDED_POSES.length - 1)] || null;
  }

  function updateGuidedCaptureUI(messageOverride = null) {
    const poseStep = document.getElementById("camera-pose-step");
    const poseStatus = document.getElementById("camera-pose-status");
    const posePrompt = document.getElementById("camera-pose-prompt");
    const progressBar = document.getElementById("camera-pose-progress-bar");
    const checklistItems = document.querySelectorAll("#camera-pose-checklist [data-pose]");
    const currentPose = getGuidedPose();
    const completedCount = Math.min(studentMediaState.guidedPoseIndex, GUIDED_POSES.length);
    const progressPercent = Math.round((completedCount / GUIDED_POSES.length) * 100);

    if (poseStep) {
      poseStep.textContent = studentMediaState.guidedCompleted
        ? `Completed ${GUIDED_POSES.length} of ${GUIDED_POSES.length}`
        : `Step ${completedCount + 1} of ${GUIDED_POSES.length}`;
    }

    if (poseStatus) {
      poseStatus.textContent = studentMediaState.guidedCompleted
        ? "Pose set complete"
        : studentMediaState.captureMode === "guided"
          ? "Auto capture active"
          : "Manual capture active";
    }

    if (posePrompt) {
      posePrompt.textContent = messageOverride || (studentMediaState.guidedCompleted
        ? "All 5 required angles were captured. Save the student profile."
        : currentPose?.prompt || "Start the camera to begin guided capture.");
    }

    if (progressBar) {
      progressBar.style.width = `${progressPercent}%`;
    }

    checklistItems.forEach((item) => {
      const pose = item.getAttribute("data-pose");
      const isDone = GUIDED_POSES.findIndex((step) => step.key === pose) < studentMediaState.guidedPoseIndex;
      const isActive = !studentMediaState.guidedCompleted && currentPose?.key === pose;
      item.classList.toggle("done", isDone);
      item.classList.toggle("active", isActive);
    });
  }

  function setCaptureMode(mode) {
    studentMediaState.captureMode = mode;
    document.querySelectorAll(".capture-mode-btn").forEach((button) => {
      button.classList.toggle("active", button.getAttribute("data-capture-mode") === studentMediaState.captureMode);
    });

    const opencvBtn = document.getElementById("student-btn-opencv-enroll");
    const webStartBtn = document.getElementById("student-btn-start-camera");
    const captureBtn = document.getElementById("student-btn-capture-photo");

    if (mode === "opencv") {
      if (opencvBtn) opencvBtn.style.display = "inline-flex";
      if (webStartBtn) webStartBtn.style.display = "inline-flex";
      if (captureBtn) captureBtn.style.display = "none";
      updateGuidedCaptureUI("Click 'Start OpenCV Video Enrollment' to stream on-screen face angle guidance.");
    } else if (mode === "guided") {
      if (opencvBtn) opencvBtn.style.display = "none";
      if (webStartBtn) webStartBtn.style.display = "inline-flex";
      if (captureBtn) captureBtn.style.display = "none";
      updateGuidedCaptureUI("Guided capture will auto-collect the pose set when the camera starts.");
    } else {
      if (opencvBtn) opencvBtn.style.display = "none";
      if (webStartBtn) webStartBtn.style.display = "inline-flex";
      if (captureBtn) captureBtn.style.display = "inline-flex";
      updateGuidedCaptureUI("Manual capture enabled. Use the Capture Pose button whenever a face is centered.");
    }
  }

  function resetGuidedCaptureState() {
    studentMediaState.guidedPoseIndex = 0;
    studentMediaState.guidedStableFrames = 0;
    studentMediaState.guidedLastCaptureAt = 0;
    studentMediaState.guidedCompleted = false;
    updateGuidedCaptureUI();
  }

  function finishGuidedCapture(message) {
    studentMediaState.guidedCompleted = true;
    updateGuidedCaptureUI(message);
  }

  function currentCameraFrameToDataUrl() {
    const video = document.getElementById("camera-video");
    const captureCanvas = document.getElementById("camera-capture-canvas");

    if (!video || !captureCanvas) return null;

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    captureCanvas.width = width;
    captureCanvas.height = height;

    const context = captureCanvas.getContext("2d");
    context.drawImage(video, 0, 0, width, height);
    return captureCanvas.toDataURL("image/jpeg", 0.85);
  }

  async function requestPoseCheck() {
    const now = Date.now();
    if (now - studentMediaState.guidedLastPoseCheckAt < 400) {
      return null;
    }

    const currentPose = getGuidedPose();
    const frameData = currentCameraFrameToDataUrl();
    if (!currentPose || !frameData) return null;

    studentMediaState.guidedLastPoseCheckAt = now;

    try {
      const response = await fetch(`${API_BASE_URL}/api/student/pose-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame: frameData, target_pose: currentPose.key }),
      });
      const payload = await response.json();

      if (payload.status !== "success") return null;

      return payload;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  function captureGuidedPose(labelOverride = null) {
    const poseKey = typeof labelOverride === "string" ? labelOverride : (labelOverride?.key || getGuidedPose()?.key);
    const base64 = currentCameraFrameToDataUrl();

    if (!base64) return false;

    if (addCapturedImage(base64, poseKey || `pose-${getTotalStudentImages() + 1}`)) {
      studentMediaState.guidedLastCaptureAt = Date.now();
      studentMediaState.guidedStableFrames = 0;
      studentMediaState.guidedPoseIndex += 1;

      if (studentMediaState.guidedPoseIndex >= GUIDED_POSES.length) {
        playCompletionChime();
        finishGuidedCapture(`🎉 All ${GUIDED_POSES.length} guided poses captured! Review thumbnails below and save the student profile.`);
        const captureButton = document.getElementById("student-btn-capture-photo");
        if (captureButton) captureButton.disabled = true;
      } else {
        const nextPose = getGuidedPose();
        updateGuidedCaptureUI(`Captured ${poseKey}! Next: ${nextPose?.prompt || "keep going"}`);
      }

      return true;
    }

    return false;
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
    if (uploadCounter) uploadCounter.textContent = `${totalImages}/${MAX_STUDENT_IMAGES} photos selected`;
    if (cameraCounter) cameraCounter.textContent = `${totalImages}/${MAX_STUDENT_IMAGES} photos captured`;
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
        <div class="thumb-label">${image.poseLabel || image.name}</div>
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
    updateGuidedCaptureUI("Camera stopped. You can restart capture whenever you're ready.");

    const startButton = document.getElementById("student-btn-start-camera");
    const stopButton = document.getElementById("student-btn-stop-camera");
    const captureButton = document.getElementById("student-btn-capture-photo");
    const opencvBtn = document.getElementById("student-btn-opencv-enroll");

    stopOpenCvEnrollment();

    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    if (captureButton) captureButton.disabled = true;
    if (opencvBtn) opencvBtn.disabled = false;
  }

  const openCvEnrollmentState = {
    pollInterval: null,
    isEnrolling: false,
  };

  function stopOpenCvEnrollment() {
    if (openCvEnrollmentState.pollInterval) {
      clearInterval(openCvEnrollmentState.pollInterval);
      openCvEnrollmentState.pollInterval = null;
    }
    openCvEnrollmentState.isEnrolling = false;

    const streamImg = document.getElementById("opencv-enrollment-stream");
    if (streamImg) {
      streamImg.style.display = "none";
      streamImg.src = "";
    }

    const manualBtn = document.getElementById("student-btn-manual-capture");
    if (manualBtn) manualBtn.style.display = "none";

    fetch(`${API_BASE_URL}/api/enrollment/stop`, { method: "POST" }).catch(() => {});
  }

  async function startOpenCvEnrollment() {
    const studentIdInput = document.getElementById("student-id");
    const studentNameInput = document.getElementById("student-name");
    const studentCourseInput = document.getElementById("student-course");
    const studentYearInput = document.getElementById("student-year");
    const studentSemesterInput = document.getElementById("student-semester");
    const editModeInput = document.getElementById("edit-mode");
    const isEditMode = editModeInput?.value === "true";

    const studentId = studentIdInput?.value.trim();
    const name = studentNameInput?.value.trim();
    const course = studentCourseInput?.value.trim();
    const year = studentYearInput?.value.trim();
    const semester = studentSemesterInput?.value.trim();

    if (!studentId || !name || !course || !year) {
      showToast("Please fill in Student ID, Name, Subject, and Year before starting OpenCV Video Enrollment.", "error");
      return;
    }

    stopCamera();

    try {
      const response = await fetch(`${API_BASE_URL}/api/enrollment/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: studentId, name, course, year, semester, is_update: isEditMode }),
      });
      const data = await response.json();

      if (data.status !== "success") {
        showToast(data.error_message || "Failed to start OpenCV Video Enrollment", "error");
        return;
      }

      openCvEnrollmentState.isEnrolling = true;
      showToast("OpenCV Video Enrollment started! Follow on-screen instructions.", "success");

      const streamImg = document.getElementById("opencv-enrollment-stream");
      if (streamImg) {
        streamImg.style.display = "block";
        streamImg.src = `${API_BASE_URL}/api/enrollment/video_feed?t=${Date.now()}`;
      }

      const opencvBtn = document.getElementById("student-btn-opencv-enroll");
      const stopBtn = document.getElementById("student-btn-stop-camera");
      const manualBtn = document.getElementById("student-btn-manual-capture");
      if (opencvBtn) opencvBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      if (manualBtn) manualBtn.style.display = "inline-flex";

      openCvEnrollmentState.pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/api/enrollment/status`);
          const payload = await res.json();
          if (payload.status !== "success") return;

          const enrollment = payload.enrollment;
          if (!enrollment) return;

          updateGuidedCaptureUI(enrollment.message);

          if (enrollment.completed) {
            stopOpenCvEnrollment();
            showToast(enrollment.message || "Enrollment complete!", "success");
            playCompletionChime();
            resetStudentForm();
            loadStudentsList();
            if (opencvBtn) opencvBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
          }
        } catch (err) {
          console.error(err);
        }
      }, 500);

    } catch (error) {
      console.error(error);
      showToast("Error starting OpenCV enrollment session", "error");
    }
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
        resetGuidedCaptureState();
        
        console.log("✅ Camera started successfully!");

        if (startButton) startButton.disabled = true;
        if (stopButton) stopButton.disabled = false;
        if (captureButton) captureButton.disabled = false;

        const statusText = document.getElementById("student-camera-status-text");
        if (statusText) statusText.textContent = studentMediaState.captureMode === "guided"
          ? "Camera active - guided pose capture running"
          : "Camera active - face detection running";

        updateFaceIndicator(false, studentMediaState.captureMode === "guided" ? "Follow the pose prompt" : "Scanning for a face...");
        updateGuidedCaptureUI();
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

    if (studentMediaState.captureMode === "guided") {
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * 0.32;
      const totalPoses = GUIDED_POSES.length;
      const completedCount = studentMediaState.guidedPoseIndex;

      const segmentGap = 0.08;
      const anglePerSegment = (Math.PI * 2) / totalPoses;

      for (let i = 0; i < totalPoses; i++) {
        const startAngle = i * anglePerSegment - Math.PI / 2 + segmentGap / 2;
        const endAngle = (i + 1) * anglePerSegment - Math.PI / 2 - segmentGap / 2;

        context.beginPath();
        context.arc(cx, cy, radius, startAngle, endAngle);
        context.lineWidth = 8;
        context.lineCap = "round";

        if (i < completedCount) {
          context.strokeStyle = "#10b981";
          context.shadowColor = "#10b981";
          context.shadowBlur = 10;
        } else if (i === completedCount && !studentMediaState.guidedCompleted) {
          context.strokeStyle = studentMediaState.faceVisible ? "#06b6d4" : "#3b82f6";
          context.shadowColor = "#06b6d4";
          context.shadowBlur = 14;
        } else {
          context.strokeStyle = "rgba(255, 255, 255, 0.18)";
          context.shadowBlur = 0;
        }
        context.stroke();
        context.shadowBlur = 0;
      }

      if (faces && faces.length > 0) {
        faces.forEach((face) => {
          const box = face.boundingBox || face;
          const x = box.x ?? box.left ?? 0;
          const y = box.y ?? box.top ?? 0;
          const w = box.width ?? (box.right ? box.right - x : 0);
          const h = box.height ?? (box.bottom ? box.bottom - y : 0);
          context.lineWidth = 2;
          context.strokeStyle = "#10b981";
          context.strokeRect(x, y, w, h);
        });
      }
    } else {
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

    try {
      let faces = [];
      let hasFace = true;

      if (window.FaceDetector) {
        if (!studentMediaState.faceDetector) {
          studentMediaState.faceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
        }
        faces = await studentMediaState.faceDetector.detect(captureCanvas);
        hasFace = Array.isArray(faces) && faces.length > 0;
        drawFaceBoxes(faces, width, height);
      } else {
        drawFaceBoxes([{ boundingBox: { x: width * 0.25, y: height * 0.15, width: width * 0.5, height: height * 0.7 } }], width, height);
      }

      updateFaceIndicator(hasFace, hasFace ? "Face detected" : "No face detected");

      if (studentMediaState.captureMode === "guided" && !studentMediaState.guidedCompleted) {
        const poseResult = await requestPoseCheck();

        if (poseResult && poseResult.face_detected) {
          studentMediaState.faceVisible = true;
          studentMediaState.guidedStableFrames += 1;

          const currentPose = getGuidedPose();

          if (poseResult.matches_target && Date.now() - studentMediaState.guidedLastCaptureAt > 750) {
            playSuccessChime();
            captureGuidedPose(currentPose?.key);
          } else {
            updateGuidedCaptureUI(currentPose?.prompt || "Align your face with the target angle");
          }
        } else {
          studentMediaState.guidedStableFrames = 0;
          updateFaceIndicator(false, "Position your face in the camera stream");
          updateGuidedCaptureUI("Position your face clearly in the camera view");
        }
      }
    } catch (error) {
      console.error(error);
      updateFaceIndicator(false, "Face detection processing...");
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

    const currentPose = getGuidedPose();
    const base64 = currentCameraFrameToDataUrl();
    if (!base64) return;

    if (addCapturedImage(base64, currentPose?.key || `pose-${getTotalStudentImages() + 1}`)) {
      showToast("Photo captured successfully.", "success");
    }
  }

  function addCapturedImage(base64, poseLabel = null) {
    if (getTotalStudentImages() >= MAX_STUDENT_IMAGES) {
      showToast(`You can keep up to ${MAX_STUDENT_IMAGES} photos.`, "info");
      return false;
    }

    studentMediaState.cameraImages.push({
      name: typeof poseLabel === "string" ? poseLabel : (poseLabel?.key || getImageLabel(getTotalStudentImages())),
      poseLabel: typeof poseLabel === "string" ? poseLabel : poseLabel?.key,
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

    const availableSlots = MAX_STUDENT_IMAGES - getTotalStudentImages();
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
    const studentSemesterInput = document.getElementById("student-semester");
    const saveButton = document.getElementById("btn-save-student");
    const isEditMode = editModeInput?.value === "true";

    if (!validateImages()) return;

    const formData = new FormData();
    formData.append("id", studentIdInput.value.trim());
    formData.append("name", studentNameInput.value.trim());
    formData.append("course", studentCourseInput.value.trim());
    formData.append("year", studentYearInput.value.trim());
    formData.append("semester", studentSemesterInput?.value.trim() || "");
    formData.append("image_total", String(getTotalStudentImages()));
    formData.append("capture_mode", studentMediaState.captureMode);

    studentMediaState.uploadImages.forEach((image) => {
      formData.append("photo_files[]", image.file, image.file.name);
    });

    studentMediaState.cameraImages.forEach((image) => {
      formData.append("camera_images[]", image.base64);
      formData.append("camera_pose_labels[]", image.poseLabel || image.name || "pose");
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
    const captureModeButtons = document.querySelectorAll(".capture-mode-btn");

    tabButtons.forEach((button) => {
      button.addEventListener("click", function () {
        const target = this.getAttribute("data-tab-target");
        tabButtons.forEach((btn) => btn.classList.toggle("active", btn === this));
        document.querySelectorAll(".image-panel").forEach((panel) => {
          panel.classList.toggle("active", panel.id === target);
        });
      });
    });

    captureModeButtons.forEach((button) => {
      button.addEventListener("click", function () {
        setCaptureMode(this.getAttribute("data-capture-mode"));
        if (studentMediaState.captureMode === "guided") {
          updateGuidedCaptureUI("Guided capture will auto-collect the pose set when the camera starts.");
        } else {
          updateGuidedCaptureUI("Manual capture enabled. Use the Capture Pose button whenever a face is centered.");
        }
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

    if (resetButton) resetButton.addEventListener("click", function() {
      stopOpenCvEnrollment();
      resetStudentForm();
    });
    if (studentForm) studentForm.addEventListener("submit", function (event) {
      event.preventDefault();
      submitStudent();
    });
    const opencvEnrollBtn = document.getElementById("student-btn-opencv-enroll");
    if (opencvEnrollBtn) opencvEnrollBtn.addEventListener("click", startOpenCvEnrollment);
    if (startCameraButton) startCameraButton.addEventListener("click", startCamera);
    if (stopCameraButton) stopCameraButton.addEventListener("click", function() {
      stopCamera();
      stopOpenCvEnrollment();
    });
    if (captureButton) captureButton.addEventListener("click", capturePhoto);

    const manualCaptureBtn = document.getElementById("student-btn-manual-capture");
    if (manualCaptureBtn) {
      manualCaptureBtn.addEventListener("click", async function () {
        this.disabled = true;
        this.innerHTML = '<i class="fa-solid fa-camera fa-beat"></i> Capturing...';
        try {
          const res = await fetch(`${API_BASE_URL}/api/enrollment/capture`, { method: "POST" });
          const data = await res.json();
          if (data.status === "success") {
            showToast("📸 Capture triggered!", "success");
          } else {
            showToast(data.error_message || "Could not capture", "error");
          }
        } catch (err) {
          showToast("Network error triggering capture", "error");
        } finally {
          setTimeout(() => {
            if (openCvEnrollmentState.isEnrolling) {
              this.disabled = false;
              this.innerHTML = '<i class="fa-solid fa-camera"></i> Capture Now';
            }
          }, 800);
        }
      });
    }

    if (studentSearchInput) {
      studentSearchInput.addEventListener("keyup", function () {
        const query = this.value.toLowerCase().trim();
        const rows = studentTableBody.querySelectorAll("tr");
        rows.forEach((row) => {
          if (row.cells.length < 5) return; // skip loading/empty state rows
          const idText       = row.cells[0].textContent.toLowerCase();
          const nameText     = row.cells[1].textContent.toLowerCase();
          const subjectText  = row.cells[2].textContent.toLowerCase();
          const yearText     = row.cells[3].textContent.toLowerCase();
          const semesterText = row.cells[4].textContent.toLowerCase();
          row.style.display = (
            idText.includes(query) || nameText.includes(query) ||
            subjectText.includes(query) || yearText.includes(query) ||
            semesterText.includes(query)
          ) ? "" : "none";
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
            const headers = ["ID", "Name", "Subject", "Year", "Semester", "Photo Paths", "Embedding"];
            const rows = students.map((s) => [s.id, s.name, s.course, s.year, s.semester || "", s.face_images || s.photo_path || "None", s.face_embedding ? "Stored" : "None"]);
            exportToCSV(rows, "student_list.csv", headers);
          });
      });
    }
  }

  // ============================================================
  // MANUAL CAPTURE TAB — self-contained camera + capture logic
  // ============================================================
  function setupManualCapture() {
    const startBtn   = document.getElementById("manual-btn-start");
    const captureBtn = document.getElementById("manual-btn-capture");
    const stopBtn    = document.getElementById("manual-btn-stop");
    const video      = document.getElementById("manual-camera-video");
    const canvas     = document.getElementById("manual-camera-canvas");
    const poseLabel  = document.getElementById("manual-pose-label");
    const dotsEl     = document.getElementById("manual-pose-dots");
    const previewGrid= document.getElementById("manual-preview-grid");

    if (!startBtn || !captureBtn || !video) return;

    let stream = null;
    let poseIndex = 0;
    const poses = GUIDED_POSES;

    function renderDots() {
      if (!dotsEl) return;
      dotsEl.innerHTML = poses.map((p, i) => {
        let bg = i < poseIndex  ? "#10b981"
               : i === poseIndex ? "#06b6d4"
               : "rgba(255,255,255,0.18)";
        return `<span title="${p.label}" style="
          width:12px;height:12px;border-radius:50%;
          background:${bg};display:inline-block;
          box-shadow:${i===poseIndex?"0 0 8px #06b6d4":""};
          transition:background .3s;"></span>`;
      }).join("");
    }

    function updatePoseLabel() {
      if (!poseLabel) return;
      if (poseIndex >= poses.length) {
        poseLabel.textContent = "✅ All 10 poses captured!";
      } else {
        poseLabel.textContent = `Step ${poseIndex + 1}/${poses.length} — ${poses[poseIndex].prompt}`;
      }
    }

    function renderPreview() {
      if (!previewGrid) return;
      previewGrid.innerHTML = "";
      studentMediaState.cameraImages.forEach((img, idx) => {
        const card = document.createElement("div");
        card.className = "thumbnail-card";
        card.innerHTML = `
          <button type="button" class="thumbnail-remove" data-source="camera" data-index="${idx}">×</button>
          <img src="${img.previewUrl}" alt="${img.poseLabel}" />
          <div class="thumb-label">${img.poseLabel || img.name}</div>
        `;
        previewGrid.appendChild(card);
      });
      previewGrid.querySelectorAll(".thumbnail-remove").forEach(btn => {
        btn.addEventListener("click", function() {
          removeCapturedImage(Number(this.getAttribute("data-index")), "camera");
          poseIndex = Math.max(0, poseIndex - 1);
          renderDots();
          updatePoseLabel();
          renderPreview();
          if (stream) captureBtn.disabled = false;
        });
      });
    }

    function stopManualCamera() {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      if (video) { video.srcObject = null; video.style.display = "none"; }
      captureBtn.disabled = true;
      stopBtn.disabled = true;
      startBtn.disabled = false;
    }

    startBtn.addEventListener("click", async function() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false
        });
        video.srcObject = stream;
        video.style.display = "block";
        await video.play();
        captureBtn.disabled = false;
        stopBtn.disabled = false;
        startBtn.disabled = true;
        poseIndex = studentMediaState.cameraImages.length;
        renderDots();
        updatePoseLabel();
        showToast("Camera started — position yourself and press Capture Now", "success");
      } catch(e) {
        showToast("Camera access denied or unavailable", "error");
      }
    });

    captureBtn.addEventListener("click", function() {
      if (!stream || !video || poseIndex >= poses.length) return;

      if (!canvas) return;
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.88);

      const pose = poses[poseIndex];
      if (addCapturedImage(dataUrl, pose.key)) {
        playSuccessChime();
        poseIndex++;
        renderDots();
        updatePoseLabel();
        renderPreview();
        updateImageCounters();

        this.innerHTML = '<i class="fa-solid fa-check"></i> Captured!';
        this.disabled = true;
        setTimeout(() => {
          if (poseIndex < poses.length) {
            this.innerHTML = '<i class="fa-solid fa-camera"></i> Capture Now';
            this.disabled = false;
          } else {
            this.innerHTML = '<i class="fa-solid fa-check-double"></i> All Done!';
            playCompletionChime();
            showToast(`🎉 All ${GUIDED_POSES.length} poses captured! Now click Save Student.`, "success");
            stopManualCamera();
          }
        }, 600);
      }
    });

    stopBtn.addEventListener("click", function() {
      stopManualCamera();
      showToast("Camera stopped.", "info");
    });

    renderDots();
    updatePoseLabel();
  }

  function loadStudentsList() {
    const studentTableBody = document.getElementById("student-table-body");
    if (!studentTableBody) return;

    studentTableBody.innerHTML = `<tr><td colspan="7" class="loading-item">Loading students...</td></tr>`;

    fetch(`${API_BASE_URL}/api/students`)
      .then((res) => res.json())
      .then((students) => {
        studentTableBody.innerHTML = "";
        if (students.length === 0) {
          studentTableBody.innerHTML = `<tr><td colspan="7" class="no-data-item">No students registered yet.</td></tr>`;
          return;
        }

        students.forEach((s) => {
          const tr = document.createElement("tr");
          const photoList = getStudentPhotoList(s);
          const primaryPhoto = photoList[0];
          const photoCount = photoList.length;

          let photoCell;
          if (primaryPhoto) {
            const imgSrc = API_BASE_URL + "/uploads/faces/" + encodeURI(primaryPhoto) + "?t=" + Date.now();
            const badgeLabel = photoCount + " photo" + (photoCount === 1 ? "" : "s");
            photoCell = '<div class="table-photo-cell">'
              + '<img src="' + imgSrc + '" alt="Face" />'
              + '<span style="display:block;margin-top:.35rem;padding:.15rem .45rem;border-radius:999px;background:rgba(59,130,246,.15);color:#93c5fd;font-size:.72rem;font-weight:700;text-align:center;">' + badgeLabel + '</span>'
              + '</div>';
          } else {
            photoCell = '<div class="table-photo-cell" style="background:rgba(239,68,68,0.1)"><i class="fa-solid fa-circle-xmark absent-icon"></i></div>';
          }

          const semesterVal = (s.semester && s.semester.trim()) ? s.semester : '-';
          const subjectVal  = (s.course   && s.course.trim())   ? s.course   : '-';
          const yearVal     = (s.year     && s.year.trim())     ? s.year     : '-';

          tr.innerHTML =
            '<td><strong>' + s.id + '</strong></td>' +
            '<td>' + s.name + '</td>' +
            '<td>' + subjectVal + '</td>' +
            '<td>' + yearVal + '</td>' +
            '<td>' + semesterVal + '</td>' +
            '<td>' + photoCell + '</td>' +
            '<td><div class="row-actions">' +
              '<button class="btn-action edit-btn" data-id="' + s.id + '" title="✏️ Edit"><i class="fa-solid fa-pen-to-square"></i></button>' +
              '<button class="btn-action delete-btn" data-id="' + s.id + '" title="🗑️ Delete"><i class="fa-solid fa-trash-can"></i></button>' +
            '</div></td>';
          studentTableBody.appendChild(tr);
        });

        setupTableActionListeners(students);
      })
      .catch((err) => {
        console.error(err);
        studentTableBody.innerHTML = `<tr><td colspan="7" class="no-data-item" style="color:var(--danger)">Error fetching student list.</td></tr>`;
      });
  }

  function setupTableActionListeners(students) {
    const studentTableBody = document.getElementById("student-table-body");
    const editModeInput = document.getElementById("edit-mode");
    const studentIdInput = document.getElementById("student-id");
    const studentNameInput = document.getElementById("student-name");
    const studentCourseInput = document.getElementById("student-course");
    const studentYearInput = document.getElementById("student-year");
    const studentSemesterInput = document.getElementById("student-semester");
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
          if (studentSemesterInput) studentSemesterInput.value = student.semester || "";

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
      setCaptureMode("guided");
      resetGuidedCaptureState();
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
    if (btnStop) btnStop.addEventListener("click", () => stopCameraCapture(false));
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
    const sessionStatusTag = document.getElementById("session-status-tag");
    const sessionStatusLabel = document.getElementById("session-status-label");
    const saveReminder = document.getElementById("save-reminder");
    const liveSessionInfoLabel = document.getElementById("live-session-info-label");

    if (!btnStart) return;

    btnStart.disabled = true;
    btnStart.textContent = "⏳ Starting...";

    // Read session fields with new metadata
    const department = (document.getElementById("session-department")?.value || "").trim();
    const semester = (document.getElementById("session-semester")?.value || "").trim();
    const year = (document.getElementById("session-year")?.value || "").trim();
    const subject = (document.getElementById("session-subject")?.value || "").trim();
    const className = (document.getElementById("session-class")?.value || "").trim();
    const section = (document.getElementById("session-section")?.value || "").trim();
    const instructor = (document.getElementById("session-instructor")?.value || "").trim();

    fetch(`${API_BASE_URL}/api/live/start`, { 
        method: "POST",
        headers: { 'Content-Type': 'application/json' }
    })
    .then((res) => res.json())
    .then((data) => {
        if (data.status === "success") {
            showToast("Camera feed active. Scanning for faces...", "success");
            
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

            if (sessionStatusTag) sessionStatusTag.classList.add("active");
            if (sessionStatusLabel) sessionStatusLabel.textContent = "Session Active";
            if (saveReminder) saveReminder.style.display = "block";

            // Update session info summary text with all metadata
            const parts = [];
            if (department) parts.push(`Dept: ${department}`);
            if (semester) parts.push(`Sem: ${semester}`);
            if (year) parts.push(`Year: ${year}`);
            if (subject) parts.push(`Subject: ${subject}`);
            if (className) parts.push(`Class: ${className}`);
            if (section) parts.push(`Sec: ${section}`);
            if (instructor) parts.push(`Instructor: ${instructor}`);
            if (liveSessionInfoLabel) {
              liveSessionInfoLabel.textContent = parts.length > 0 ? parts.join(" | ") : "General Session";
            }

            setSessionInputsDisabled(true);

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

  function setSessionInputsDisabled(disabled) {
    ["session-department", "session-semester", "session-year", "session-subject", "session-class", "session-section", "session-instructor"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
  }

  function stopCameraCapture(saveSession = true) {
    if (livePollInterval) {
      clearInterval(livePollInterval);
      livePollInterval = null;
    }

    const department = (document.getElementById("session-department")?.value || "").trim();
    const semester = (document.getElementById("session-semester")?.value || "").trim();
    const year = (document.getElementById("session-year")?.value || "").trim();
    const subject = (document.getElementById("session-subject")?.value || "").trim();
    const instructor = (document.getElementById("session-instructor")?.value || "").trim();

    if (saveSession) {
      const missing = [
        ['Department', department], ['Semester', semester], ['Year', year],
        ['Subject', subject], ['Instructor', instructor]
      ].filter(([, value]) => !value).map(([label]) => label);
      if (missing.length) {
        showToast(`Complete session details before saving: ${missing.join(', ')}.`, 'error');
        return;
      }
    }

    fetch(`${API_BASE_URL}/api/live/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        save: saveSession,
        department: department,
        semester: semester,
        year: year,
        subject: subject,
        instructor: instructor
      })
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "success") {
          if (saveSession) {
            showToast("Session saved! Attendance records written to database.", "success");
            // Auto refresh records list
            if (typeof loadRecordsList === "function") {
              loadRecordsList();
            }
          } else {
            showToast("Session stopped. Attendance was DISCARDED without saving.", "info");
          }
          resetCameraViewport();
          fetchLiveStatus();
          // Refresh dashboard stats if active
          const dash = document.getElementById('dashboard-section');
          if (dash && dash.style.display !== 'none' && typeof loadDashboardStats === "function") {
            loadDashboardStats();
          }
        } else {
          showToast(data.error_message || "Error stopping session", "error");
          resetCameraViewport();
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
    const sessionStatusTag = document.getElementById("session-status-tag");
    const sessionStatusLabel = document.getElementById("session-status-label");
    const saveReminder = document.getElementById("save-reminder");

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

    if (sessionStatusTag) sessionStatusTag.classList.remove("active");
    if (sessionStatusLabel) sessionStatusLabel.textContent = "No Active Session";
    if (saveReminder) saveReminder.style.display = "none";

    setSessionInputsDisabled(false);

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

  // --- 4. Enhanced Records View Controller ---
  
  // Load filter options for dropdowns
  function loadFilterOptions() {
    fetch(`${API_BASE_URL}/api/attendance/filters`)
      .then(res => res.json())
      .then(data => {
        if (data.status === 'success') {
          // Populate department filter
          const deptFilter = document.getElementById('filter-department');
          if (deptFilter) {
            deptFilter.innerHTML = '<option value="">All Departments</option>';
            data.departments.forEach(d => {
              const opt = document.createElement('option');
              opt.value = d;
              opt.textContent = d;
              deptFilter.appendChild(opt);
            });
          }
          
          // Populate semester filter
          const semFilter = document.getElementById('filter-semester');
          if (semFilter) {
            semFilter.innerHTML = '<option value="">All Semesters</option>';
            data.semesters.forEach(s => {
              const opt = document.createElement('option');
              opt.value = s;
              opt.textContent = s;
              semFilter.appendChild(opt);
            });
          }
          
          // Populate subject filter
          const subFilter = document.getElementById('filter-subject');
          if (subFilter) {
            subFilter.innerHTML = '<option value="">All Subjects</option>';
            data.subjects.forEach(s => {
              const opt = document.createElement('option');
              opt.value = s;
              opt.textContent = s;
              subFilter.appendChild(opt);
            });
          }

          const yearFilter = document.getElementById('filter-year');
          if (yearFilter) {
            yearFilter.innerHTML = '<option value="">All Years</option>';
            data.years.forEach(y => {
              const opt = document.createElement('option');
              opt.value = y;
              opt.textContent = y;
              yearFilter.appendChild(opt);
            });
          }

          const instructorFilter = document.getElementById('filter-instructor');
          if (instructorFilter) {
            instructorFilter.innerHTML = '<option value="">All Instructors</option>';
            data.instructors.forEach(i => {
              const opt = document.createElement('option');
              opt.value = i;
              opt.textContent = i;
              instructorFilter.appendChild(opt);
            });
          }
        }
      })
      .catch(err => console.error('Error loading filters:', err));
  }

  let currentViewMode = 'detailed';

  function setupRecordsFilters() {
    const filterDate = document.getElementById("filter-date");
    const filterDateTo = document.getElementById("filter-date-to");
    const filterDepartment = document.getElementById("filter-department");
    const filterSemester = document.getElementById("filter-semester");
    const filterSubject = document.getElementById("filter-subject");
    const filterYear = document.getElementById("filter-year");
    const filterInstructor = document.getElementById("filter-instructor");
    const filterSearch = document.getElementById("filter-search");
    const btnApply = document.getElementById("btn-apply-filters");
    const btnReset = document.getElementById("btn-reset-filters");
    const btnExport = document.getElementById("btn-export-records-csv");
    const btnToggleAdvanced = document.getElementById("btn-toggle-advanced");
    const advancedPanel = document.getElementById("advanced-filter-panel");
    const viewTabs = document.querySelectorAll(".records-tab");

    // --- View mode switching ---
    viewTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        viewTabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        currentViewMode = tab.dataset.tab;
        loadAttendanceSummary(currentViewMode);
      });
    });

    // --- Advanced filter toggle ---
    if (btnToggleAdvanced && advancedPanel) {
      btnToggleAdvanced.addEventListener("click", () => {
        const isOpen = advancedPanel.classList.toggle("open");
        btnToggleAdvanced.classList.toggle("active", isOpen);
        if (isOpen) {
          loadFilterOptions();
        }
      });
    }

    // --- Apply / Reset ---
    if (btnApply) btnApply.addEventListener("click", () => {
      loadAttendanceSummary(currentViewMode);
    });

    if (btnReset) {
      btnReset.addEventListener("click", () => {
        if (filterDate) filterDate.value = "";
        if (filterDateTo) filterDateTo.value = "";
        if (filterDepartment) filterDepartment.value = "";
        if (filterSemester) filterSemester.value = "";
        if (filterSubject) filterSubject.value = "";
        if (filterYear) filterYear.value = "";
        if (filterInstructor) filterInstructor.value = "";
        if (filterSearch) filterSearch.value = "";
        loadAttendanceSummary(currentViewMode);
      });
    }

    // --- Export CSV ---
    if (btnExport) {
      btnExport.addEventListener("click", () => {
        const params = _buildReportParams();
        const mode = currentViewMode;
        const format = 'csv';
        const url = `${API_BASE_URL}/api/reports/export?mode=${mode}&format=${format}${params}`;
        window.open(url, '_blank');
        showToast(`Exporting ${mode} report as CSV...`, 'success');
      });
    }

    // --- Search on Enter ---
    if (filterSearch) {
      filterSearch.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') loadAttendanceSummary(currentViewMode);
      });
    }

    // Initial load
    loadAttendanceSummary('detailed');
  }

  function _buildReportParams() {
    const dateFrom = document.getElementById("filter-date")?.value || "";
    const dateTo = document.getElementById("filter-date-to")?.value || "";
    const department = document.getElementById("filter-department")?.value || "";
    const semester = document.getElementById("filter-semester")?.value || "";
    const subject = document.getElementById("filter-subject")?.value || "";
    const year = document.getElementById("filter-year")?.value || "";
    const instructor = document.getElementById("filter-instructor")?.value || "";
    const search = document.getElementById("filter-search")?.value || "";

    let params = "";
    if (dateFrom) params += `&date_from=${encodeURIComponent(dateFrom)}`;
    if (dateTo) params += `&date_to=${encodeURIComponent(dateTo)}`;
    if (department) params += `&department=${encodeURIComponent(department)}`;
    if (semester) params += `&semester=${encodeURIComponent(semester)}`;
    if (subject) params += `&subject=${encodeURIComponent(subject)}`;
    if (year) params += `&year=${encodeURIComponent(year)}`;
    if (instructor) params += `&instructor=${encodeURIComponent(instructor)}`;
    if (search) params += `&search=${encodeURIComponent(search)}`;
    return params;
  }

  function loadAttendanceSummary(mode) {
    const container = document.getElementById("records-section");
    if (!container) return;

    const recordsTableBody = document.getElementById("records-table-body");
    const recordsTotalCount = document.getElementById("records-total-count");
    const recordsSectionTitle = document.getElementById("records-section-title");
    const recordsTableHead = document.getElementById("records-table-head");

    if (!recordsTableBody) return;

    // Update title based on mode
    const titles = {
      detailed: '📋 Detailed Attendance Logs',
      subject: '📚 Subject & Department Summary',
      student: '👤 Student Performance Report'
    };
    if (recordsSectionTitle) {
      recordsSectionTitle.textContent = titles[mode] || 'Attendance Records';
    }
    if (recordsTableHead) {
      const headers = mode === 'subject'
        ? ['#', 'Department', 'Semester', 'Year', 'Subject', 'Instructor', 'Sessions', 'Present Logs', 'Students', 'Rate']
        : mode === 'student'
          ? ['#', 'Student ID', 'Student Name', 'Course / Year', 'Present', 'Absent', 'Sessions', 'Rate', 'Status', 'Last Check-in']
          : ['#', 'Student ID', 'Student Name', 'Course / Year', 'Date', 'Time', 'Department', 'Semester', 'Subject', 'Instructor', 'Status'];
      recordsTableHead.innerHTML = `<tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr>`;
    }

    recordsTableBody.innerHTML = `<tr><td colspan="11" class="loading-item">Loading ${mode} report...</td></tr>`;

    const params = _buildReportParams();
    const url = `${API_BASE_URL}/api/attendance/summary?mode=${mode}${params}`;

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.status !== 'success') {
          recordsTableBody.innerHTML = `<tr><td colspan="11" class="no-data-item" style="color:var(--danger)">Error: ${data.error_message}</td></tr>`;
          if (recordsTotalCount) recordsTotalCount.textContent = "Total: 0";
          return;
        }

        recordsTableBody.innerHTML = "";
        let totalCount = 0;

        if (mode === 'detailed') {
          totalCount = data.total_records || 0;
          if (data.records.length === 0) {
            recordsTableBody.innerHTML = `<tr><td colspan="11" class="no-data-item">No attendance logs found.</td></tr>`;
          } else {
            data.records.forEach((r) => {
              const tr = document.createElement("tr");
              const statusClass = r.status === 'Present' ? 'present' : 'absent';
              tr.innerHTML = `
                <td>${r.index}</td>
                <td><strong>${r.student_id}</strong></td>
                <td>${r.student_name}</td>
                <td>${r.course} / ${r.year}</td>
                <td>${r.date}</td>
                <td>${r.time}</td>
                <td>${r.department || '-'}</td>
                <td>${r.semester || '-'}</td>
                <td>${r.subject || '-'}</td>
                <td>${r.instructor || '-'}</td>
                <td><span class="status-cell-badge ${statusClass}">${r.status}</span></td>
              `;
              recordsTableBody.appendChild(tr);
            });
          }
        } else if (mode === 'subject') {
          totalCount = data.total_subjects || 0;
          if (data.records.length === 0) {
            recordsTableBody.innerHTML = `<tr><td colspan="10" class="no-data-item">No subject summaries found.</td></tr>`;
          } else {
            data.records.forEach((r) => {
              const tr = document.createElement("tr");
              const rate = r.attendance_rate || 0;
              const barColor = rate >= 75 ? '#10b981' : rate >= 50 ? '#f59e0b' : '#ef4444';
              tr.innerHTML = `
                <td>${r.index}</td>
                <td><strong>${r.department || '-'}</strong></td>
                <td>${r.semester || '-'}</td>
                <td>${r.year || '-'}</td>
                <td>${r.subject || '-'}</td>
                <td>${r.instructor || '-'}</td>
                <td>${r.total_sessions}</td>
                <td>${r.present_logs}</td>
                <td>${r.unique_students}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:0.5rem;">
                    <div style="flex:1;height:8px;background:#1e293b;border-radius:4px;overflow:hidden;">
                      <div style="width:${Math.min(rate, 100)}%;height:100%;background:${barColor};border-radius:4px;"></div>
                    </div>
                    <span style="font-weight:600;color:${barColor};min-width:50px;">${rate}%</span>
                  </div>
                </td>
              `;
              recordsTableBody.appendChild(tr);
            });
          }
        } else if (mode === 'student') {
          totalCount = data.total_students || 0;
          if (data.records.length === 0) {
            recordsTableBody.innerHTML = `<tr><td colspan="9" class="no-data-item">No student performance data found.</td></tr>`;
          } else {
            data.records.forEach((r) => {
              const tr = document.createElement("tr");
              const rate = r.attendance_rate || 0;
              let statusLabel = '⚠️ Warning';
              let statusColor = '#f59e0b';
              let statusBg = 'rgba(245,158,11,0.15)';
              if (rate >= 80) {
                statusLabel = '✅ Good';
                statusColor = '#10b981';
                statusBg = 'rgba(16,185,129,0.15)';
              } else if (rate < 50) {
                statusLabel = '❌ Needs Improvement';
                statusColor = '#ef4444';
                statusBg = 'rgba(239,68,68,0.15)';
              }
              tr.innerHTML = `
                <td>${r.index}</td>
                <td><strong>${r.student_id}</strong></td>
                <td>${r.student_name}</td>
                <td>${r.course} / ${r.year}</td>
                <td>${r.present_days}</td>
                <td>${r.absent_days}</td>
                <td>${r.total_days}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:0.5rem;">
                    <div style="flex:1;height:8px;background:#1e293b;border-radius:4px;overflow:hidden;">
                      <div style="width:${Math.min(rate, 100)}%;height:100%;background:${rate >= 80 ? '#10b981' : rate >= 50 ? '#f59e0b' : '#ef4444'};border-radius:4px;"></div>
                    </div>
                    <span style="font-weight:600;min-width:50px;">${rate}%</span>
                  </div>
                </td>
                <td><span style="padding:0.2rem 0.6rem;border-radius:4px;background:${statusBg};color:${statusColor};font-size:0.8rem;font-weight:600;">${statusLabel}</span></td>
                <td>${r.last_checkin || '-'}</td>
              `;
              recordsTableBody.appendChild(tr);
            });
          }
        }

        if (recordsTotalCount) {
          const label = mode === 'detailed' ? 'Records' : mode === 'subject' ? 'Subjects' : 'Students';
          recordsTotalCount.textContent = `Total ${label}: ${totalCount}`;
        }
      })
      .catch(err => {
        console.error(err);
        recordsTableBody.innerHTML = `<tr><td colspan="10" class="no-data-item" style="color:var(--danger)">Error loading report.</td></tr>`;
      });
  }

  // --- Helper: Robust CSV Exporter ---
  function exportToCSV(dataRows, filename, headers = null) {
    if (!dataRows || dataRows.length === 0) {
      showToast("No data to export.", "info");
      return;
    }

    const lines = [];

    const formatCell = (cell) => {
      if (cell === null || cell === undefined) return '""';
      const str = String(cell);
      if (str.includes(",") || str.includes("\n") || str.includes("\r") || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    if (headers) {
      lines.push(headers.map(formatCell).join(","));
    }

    dataRows.forEach((row) => {
      lines.push(row.map(formatCell).join(","));
    });

    const csvContent = "\uFEFF" + lines.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    setTimeout(() => URL.revokeObjectURL(url), 500);

    showToast(`CSV file "${filename}" downloaded successfully.`, "success");
  }

  // ============================================
  // INITIALIZE PAGE
  // ============================================
  if (isStudents) {
    setupStudentForm();
    setupManualCapture();
  }
  if (isAttendance) {
    setupCameraControls();
    fetchLiveStatus();
    loadFilterOptions();
  }
  if (isRecords) {
    setupRecordsFilters();
    loadFilterOptions();
  }

}); // END OF DOMContentLoaded
