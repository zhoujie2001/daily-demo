// import { useState } from "react";
import { Mail, ExternalLink, Image as ImageIcon, Film, Link as LinkIcon, Send, X, Edit2, Trash2, Plus } from "lucide-react";
import dailyData from "./data/dailyData.json";
import { useEffect, useRef, useState } from "react";

export default function App() {
    const sliderRef = useRef(null);
    const contentRef = useRef(null);

  useEffect(() => {
        const slider = sliderRef.current;
        const handleEsc = (e) => {
        if (e.key === "Escape") {
          setActivePhoto(null);
        }
      };
        if (!slider) return;

        let scrollAmount = 0;
        let animationFrame;

        const speed = 0.5;

        const scroll = () => {
          scrollAmount += speed;
          slider.scrollLeft = scrollAmount;

          if (scrollAmount >= slider.scrollWidth / 2) {
            scrollAmount = 0;
            slider.scrollLeft = 0;
          }
          // console.log(slider.scrollLeft);
          animationFrame = requestAnimationFrame(scroll);
        };

        animationFrame = requestAnimationFrame(scroll);

        const stop = () => cancelAnimationFrame(animationFrame);
        const start = () => {
          animationFrame = requestAnimationFrame(scroll);
        };

        window.addEventListener("keydown", handleEsc);
        return () => window.removeEventListener("keydown", handleEsc);
        

        slider.addEventListener("mouseenter", stop);
        slider.addEventListener("mouseleave", start);

        return () => {
          cancelAnimationFrame(animationFrame);
          slider.removeEventListener("mouseenter", stop);
          slider.removeEventListener("mouseleave", start);
        };
  }, []); 


  const [activePhoto, setActivePhoto] = useState(null);
  const [updateText, setUpdateText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [activeDate, setActiveDate] = useState(null);

  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);

  const handlePhotoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploadingPhoto(true);
    try {
      const loginRes = await fetch('https://daily-demo-backend.vercel.app/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'password123' })
      });
      if (!loginRes.ok) throw new Error("Login failed");
      const loginData = await loginRes.json();

      const formData = new FormData();
      formData.append('files', file);

      const uploadRes = await fetch('https://daily-demo-backend.vercel.app/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${loginData.token}` },
        body: formData
      });
      const uploadData = await uploadRes.json();
      const newUrl = uploadData.urls[0];

      const res = await fetch('https://daily-demo-backend.vercel.app/api/photos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${loginData.token}`
        },
        body: JSON.stringify({
          title: file.name.split('.')[0] || "New Photo",
          desc: "New upload",
          url: newUrl
        })
      });
      const newPhoto = await res.json();
      setPhotoData([newPhoto, ...photoData]);
    } catch (err) {
      console.error("Failed to upload photo:", err);
      alert("上传照片失败");
    } finally {
      setIsUploadingPhoto(false);
      e.target.value = '';
    }
  };

  const handleVideoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploadingVideo(true);
    try {
      const loginRes = await fetch('https://daily-demo-backend.vercel.app/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'password123' })
      });
      if (!loginRes.ok) throw new Error("Login failed");
      const loginData = await loginRes.json();

      const formData = new FormData();
      formData.append('files', file);

      const uploadRes = await fetch('https://daily-demo-backend.vercel.app/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${loginData.token}` },
        body: formData
      });
      const uploadData = await uploadRes.json();
      const newUrl = uploadData.urls[0];

      const res = await fetch('https://daily-demo-backend.vercel.app/api/videos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${loginData.token}`
        },
        body: JSON.stringify({
          title: file.name.split('.')[0] || "New Video",
          url: newUrl
        })
      });
      const newVideo = await res.json();
      setVideoData([newVideo, ...videoData]);
    } catch (err) {
      console.error("Failed to upload video:", err);
      alert("上传视频失败");
    } finally {
      setIsUploadingVideo(false);
      e.target.value = '';
    }
  };

  const handleDeletePhoto = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm("确定删除这张照片吗？")) return;

    try {
      const loginRes = await fetch('https://daily-demo-backend.vercel.app/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'password123' })
      });
      const loginData = await loginRes.json();

      await fetch(`https://daily-demo-backend.vercel.app/api/photos/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${loginData.token}` }
      });
      setPhotoData(photoData.filter(p => p.id !== id));
    } catch (err) {
      console.error("Delete photo failed", err);
    }
  };

  const handleDeleteVideo = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm("确定删除这个视频吗？")) return;

    try {
      const loginRes = await fetch('https://daily-demo-backend.vercel.app/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'password123' })
      });
      const loginData = await loginRes.json();

      await fetch(`https://daily-demo-backend.vercel.app/api/videos/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${loginData.token}` }
      });
      setVideoData(videoData.filter(v => v.id !== id));
    } catch (err) {
      console.error("Delete video failed", err);
    }
  };

  const scrollToPost = (id) => {
    setActiveDate(id);
    const element = document.getElementById(id);
    if (element && contentRef.current) {
      const containerTop = contentRef.current.getBoundingClientRect().top;
      const elementTop = element.getBoundingClientRect().top;
      const scrollPos = elementTop - containerTop + contentRef.current.scrollTop;

      contentRef.current.scrollTo({
        top: scrollPos,
        behavior: 'smooth'
      });
    }
  };

  const handleScroll = () => {
    if (!contentRef.current) return;

    const elements = posts.map(post => document.getElementById(post.id)).filter(Boolean);
    const containerTop = contentRef.current.getBoundingClientRect().top;

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      // If the top of the element is near the top of the container
      if (rect.top >= containerTop - 50 && rect.top <= containerTop + 200) {
        if (activeDate !== el.id) {
          setActiveDate(el.id);
        }
        break;
      }
    }
  };

  const handleFileUpload = (e) => {
    const files = Array.from(e.target.files);
    const newAttachments = files.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      file: file,
      type: file.type.startsWith('image/') ? 'image' : 'video',
      url: URL.createObjectURL(file)
    }));
    setAttachments(prev => [...prev, ...newAttachments]);
    // Reset file input
    e.target.value = '';
  };

  const removeAttachment = (id) => {
    setAttachments(prev => {
      const filtered = prev.filter(att => att.id !== id);
      // Revoke object URL to prevent memory leaks
      const removed = prev.find(att => att.id === id);
      if (removed && removed.url) {
        URL.revokeObjectURL(removed.url);
      }
      return filtered;
    });
  };

  
  const [posts, setPosts] = useState(dailyData);
  const [photoData, setPhotoData] = useState([]);
  const [videoData, setVideoData] = useState([]);

  useEffect(() => {
    // Fetch Diary
    fetch('https://daily-demo-backend.vercel.app/api/diary')
      .then(res => {
        if (!res.ok) throw new Error("Backend not available");
        return res.json();
      })
      .then(data => {
        const mappedData = data.map(item => ({
          ...item,
          media: typeof item.media === 'string' ? JSON.parse(item.media) : item.media,
          id: `post-${item.id}`
        }));
        setPosts(mappedData);
        if (mappedData.length > 0) {
          setActiveDate(mappedData[0].id);
        }
      })
      .catch(err => {
        console.warn("Backend not reachable, falling back to static data.");
      });

    // Fetch Photos
    fetch('https://daily-demo-backend.vercel.app/api/photos')
      .then(res => {
        if (!res.ok) throw new Error("Backend not available");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setPhotoData(data);
        }
      })
      .catch(err => console.error("Error fetching photos", err));

    // Fetch Videos
    fetch('https://daily-demo-backend.vercel.app/api/videos')
      .then(res => {
        if (!res.ok) throw new Error("Backend not available");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setVideoData(data);
        }
      })
      .catch(err => console.error("Error fetching videos", err));
  }, []);

  const handleEdit = (post) => {
    setEditingId(post.id);
    setUpdateText(post.text || "");

    // Set up existing media as attachments
    if (post.media && post.media.length > 0) {
      const existingAtts = post.media.map((m, i) => ({
        id: `existing-${i}`,
        type: m.type,
        url: m.url,
        value: m.value,
        isExisting: true
      }));
      setAttachments(existingAtts);
    } else {
      setAttachments([]);
    }
  };

  const handleDelete = async (postId) => {
    if (!window.confirm("确定删除这条记录吗？")) return;

    const realId = postId.replace('post-', '');

    try {
      const loginRes = await fetch('https://daily-demo-backend.vercel.app/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'password123' })
      });

      if (!loginRes.ok) {
        throw new Error(`Login failed with status: ${loginRes.status}`);
      }

      const loginData = await loginRes.json();

      const res = await fetch(`https://daily-demo-backend.vercel.app/api/diary/${realId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${loginData.token}` }
      });

      if (res.ok) {
        setPosts(prev => prev.filter(p => p.id !== postId));
      } else {
        throw new Error(`Delete failed with status: ${res.status}`);
      }
    } catch (err) {
      console.error("Delete failed:", err);
      // Local fallback testing deletion
      setPosts(prev => prev.filter(p => p.id !== postId));
    }
  };

  const handlePublish = async () => {
    if (!updateText.trim() && attachments.length === 0) return;

    // Note: Real authentication token would be passed here
    // Upload files first if any
    const finalMedia = [];

    let loginData = null;
    let backendAvailable = true;
    try {
      const loginRes = await fetch('https://daily-demo-backend.vercel.app/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'password123' })
      });
      if (!loginRes.ok) throw new Error("Login failed");
      loginData = await loginRes.json();
    } catch(e) {
      console.warn("Backend unavailable, using local mock publish.");
      backendAvailable = false;
    }

    if (attachments.length > 0) {
      if (backendAvailable && loginData) {
        const formData = new FormData();
        attachments.forEach(att => {
          if (att.file) {
            formData.append('files', att.file);
          }
        });

        if (formData.has('files')) {
           try {
             const uploadRes = await fetch('https://daily-demo-backend.vercel.app/api/upload', {
               method: 'POST',
               headers: { 'Authorization': `Bearer ${loginData.token}` },
               body: formData
             });
             const uploadData = await uploadRes.json();

             if (uploadData.urls) {
               uploadData.urls.forEach((url, i) => {
                 finalMedia.push({
                   type: attachments[i].type,
                   url: url,
                   value: url
                 });
               });
             }
           } catch(e) {
             console.warn("Upload failed, falling back to local URLs.");
           }
        }
      } else {
        // Fallback: just use blob URLs
        attachments.forEach(att => {
          finalMedia.push({
            type: att.type,
            url: att.url,
            value: att.url
          });
        });
      }
    }

    const newPostData = {
      text: updateText.trim(),
      media: finalMedia.length > 0 ? finalMedia : attachments.map(att => ({type: att.type, url: att.url, value: att.value || att.url})),
      mediaGrid: attachments.length === 1 ? 'media-single' :
                 attachments.length === 2 ? 'media-grid-2' :
                 attachments.length >= 3 ? 'media-grid-3' : ''
    };

    if (backendAvailable && loginData) {
      const url = editingId
        ? `https://daily-demo-backend.vercel.app/api/diary/${editingId.replace('post-', '')}`
        : 'https://daily-demo-backend.vercel.app/api/diary';

      const method = editingId ? 'PUT' : 'POST';

      fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${loginData.token}`
        },
        body: JSON.stringify(newPostData)
      })
      .then(res => res.json())
      .then(item => {
        const newPost = {
          ...item,
          media: typeof item.media === 'string' ? JSON.parse(item.media) : item.media,
          id: `post-${item.id}`
        };

        if (editingId) {
          setPosts(prev => prev.map(p => p.id === editingId ? newPost : p));
        } else {
          setPosts(prev => [newPost, ...prev]);
        }

        setUpdateText("");
        setAttachments([]);
        setEditingId(null);
      })
      .catch(err => console.error("Publish failed:", err));
    } else {
      // Local fallback publish/edit
      if (editingId) {
        setPosts(prev => prev.map(p => {
          if (p.id === editingId) {
            return { ...p, text: newPostData.text, media: newPostData.media, mediaGrid: newPostData.mediaGrid };
          }
          return p;
        }));
      } else {
        const newPost = {
          id: `post-${Math.random().toString(36).substr(2, 9)}`,
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
          text: newPostData.text,
          media: newPostData.media,
          mediaGrid: newPostData.mediaGrid
        };
        setPosts(prev => [newPost, ...prev]);
      }
      setUpdateText("");
      setAttachments([]);
      setEditingId(null);
    }
  };

  const books = [
    { title: "霍乱时期的爱情", year: "2024" },
    { title: "花街往事", year: "2024" },
    { title: "献给阿尔吉侬的花束", year: "2024" },
    { title: "花开不败", year: "2024" },
    { title: "挪威的森林", year: "2024" },
    { title: "麦田里的守望者", year: "2024" },
    { title: "1988：我想和这个世界谈谈", year: "2024" },
    { title: "草民", year: "2024" },
    { title: "命运", year: "2024" },
    { title: "少年巴比伦", year: "2024" },
    { title: "追随她的旅程", year: "2024" },
  ];

  return (
    <div className="layout">
      
      {/* 左侧目录 */}
      <aside className="sidebar">
        <h2>周杰 / Dylan</h2>
        <nav>
          <a href="#about">About</a>
          <a href="#daily">Daily</a>
          <a href="#reading">Reading</a>
          <a href="#travel">Travel</a>
          <a href="#photography">Photography</a>
          <a href="#links">Links</a>
        </nav>
      </aside>

      {/* 主体内容 */}
      <main className="content">

        <section id="about">
          <h1>周杰 / Dylan</h1>
          <p className="subtitle">
            A pessimist in the third quadrant, yet passionate about movement.
          </p>
          <p>
            因为天气好，因为天气不好，因为天气感刚好。现居成都。
          </p>
        </section>

        <section id="daily" className="daily-section">
          <h2>Daily</h2>
          <div className="layout-grid">
            <aside className="col-timeline">
              <div className="timeline-header">DATE</div>
              <div className="timeline-track scrollable-timeline">
                {posts.map((post, index) => (
                  <a
                    key={post.id}
                    href={`#${post.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      scrollToPost(post.id);
                    }}
                    className={`timeline-node ${activeDate === post.id ? 'active' : ''}`}
                  >
                    {post.date}
                  </a>
                ))}
              </div>
            </aside>

            <main className="col-content" ref={contentRef} onScroll={handleScroll}>
              {posts.map((post) => (
                <article key={post.id} className="entry" id={post.id}>
                  <div className="entry-header">
                    <div className="entry-date">{post.date}</div>
                    <div className="entry-actions">
                      <button className="entry-action-btn edit" onClick={() => handleEdit(post)} title="Edit">
                        <Edit2 size={14} />
                      </button>
                      <button className="entry-action-btn delete" onClick={() => handleDelete(post.id)} title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {post.text && <div className="entry-text">{post.text}</div>}

                  {post.media && post.media.length > 0 && (
                    <div className={`entry-media ${post.mediaGrid || 'media-single'}`}>
                      {post.media.map((item, idx) => {
                        if (item.type === 'color') {
                          return <div key={idx} style={{ backgroundColor: item.value }}></div>;
                        }
                        if (item.type === 'video-placeholder') {
                          return (
                            <div key={idx} style={{ backgroundColor: item.value, height: "400px", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.5)" }}>
                              [ Video Player - 悬停播放 ]
                            </div>
                          );
                        }
                        if (item.type === 'image') {
                          return <img key={idx} src={item.url} alt="daily photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
                        }
                        if (item.type === 'video') {
                          return (
                            <video key={idx} src={item.url} muted loop playsInline onMouseEnter={(e) => { e.target.play().catch(err => console.warn("Video playback prevented:", err)); }} onMouseLeave={(e) => e.target.pause()} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          );
                        }
                        return null;
                      })}
                    </div>
                  )}
                </article>
              ))}
            </main>

            <aside className="col-editor">
              <div className="editor-panel">
                <div className="editor-header">
                  <span className="editor-title">{editingId ? 'Edit Update' : 'Write Update'}</span>
                  <div className="status-indicator">
                    <span className="status-dot" title="System Online"></span>
                    <span className="status-text">Online</span>
                  </div>
                </div>
                
                <div className="editor-body">
                  <textarea 
                    className="editor-textarea" 
                    placeholder="记录今天的碎片..."
                    value={updateText}
                    onChange={(e) => setUpdateText(e.target.value)}
                  ></textarea>
                  
                  {attachments.length > 0 && (
                    <div className="editor-attachments">
                      {attachments.map(att => (
                        <div key={att.id} className="attachment-preview">
                          {att.type === 'image' ? (
                            <img src={att.url} alt={att.name} />
                          ) : (
                            <div className="video-thumbnail"><Film size={20}/></div>
                          )}
                          <button className="remove-att-btn" onClick={() => removeAttachment(att.id)}>
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="editor-footer">
                  <div className="editor-tools">
                    <label className="tool-btn" title="Add Photo/Video">
                      <ImageIcon size={18} />
                      <input type="file" multiple accept="image/*,video/*" className="hidden-input" onChange={handleFileUpload} />
                    </label>
                    <button className="tool-btn" title="Add Link"><LinkIcon size={18} /></button>
                  </div>
                  
                  <button
                    className="publish-btn"
                    disabled={!updateText.trim() && attachments.length === 0}
                    onClick={handlePublish}
                  >
                    <span>{editingId ? 'Update' : 'Publish'}</span>
                    <Send size={14} />
                  </button>
                  {editingId && (
                    <button
                      className="publish-btn"
                      style={{ background: '#fef2f2', color: '#ef4444', marginLeft: '8px' }}
                      onClick={() => {
                        setEditingId(null);
                        setUpdateText('');
                        setAttachments([]);
                      }}
                    >
                      <span>Cancel</span>
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            </aside>
          </div>
        </section>

        <section id="reading">
          <h2>Reading_favorite</h2>
          <div className="div_books" >
            <ul className="hanging-list">
              {books.map((book, index) => (
                <li key={index}>
                  <span className="year">{book.year}</span>
                  《{book.title}》
                </li>
              ))}
            </ul>
          </div>
        </section>

            
              
        <section id="travel">

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '60px', marginBottom: '10px' }}>
            <h2 style={{ margin: 0 }}>Travel</h2>
            <div>
              <label className={`upload-btn ${isUploadingVideo ? 'disabled' : ''}`}>
                <Plus size={14} />
                <span>{isUploadingVideo ? 'Uploading...' : 'Upload Video'}</span>
                <input type="file" accept="video/*" className="hidden-input" onChange={handleVideoUpload} disabled={isUploadingVideo} />
              </label>
            </div>
          </div>
          <p style={{ marginTop: '0', color: '#666', fontSize: '14px' }}>
            嘿！快看那边。
          </p>

          <div className="slider-wrapper" ref={sliderRef}>
            <div className="video-track">
              {videoData.length > 0 ? (
                videoData.map((video, index) => (
                  <div key={index} className="video-card">
                    <video
                      src={video.url.startsWith('videos/') ? video.url : video.url.startsWith('http') ? video.url : `https://daily-demo-backend.vercel.app${video.url.startsWith('/') ? '' : '/'}${video.url}`}
                      muted
                      loop
                      playsInline
                      onMouseEnter={(e) => { e.target.play().catch(err => console.warn("Video playback prevented:", err)); }}
                      onMouseLeave={(e) => e.target.pause()}
                      style={{ width: '200px', height: '280px', objectFit: 'cover' }}
                    />
                    <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="action-btn"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const newTitle = prompt("修改视频名称:", video.title);
                          if (newTitle !== null) {
                            try {
                              const loginRes = await fetch('https://daily-demo-backend.vercel.app/api/auth/login', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ username: 'testuser', password: 'password123' })
                              });
                              const loginData = await loginRes.json();
                              await fetch(`https://daily-demo-backend.vercel.app/api/videos/${video.id}`, {
                                method: 'PUT',
                                headers: {
                                  'Content-Type': 'application/json',
                                  'Authorization': `Bearer ${loginData.token}`
                                },
                                body: JSON.stringify({ title: newTitle || video.title, url: video.url })
                              });
                              setVideoData(videoData.map(v => v.id === video.id ? { ...v, title: newTitle || video.title } : v));
                            } catch (err) { console.error(err); }
                          }
                        }}
                        title={video.title || "Edit Video"}
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        className="action-btn delete"
                        onClick={(e) => handleDeleteVideo(video.id, e)}
                        title="Delete Video"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                [1,2,3,4,5,6,7,8,9,10].map((num, index) => (
                <div key={`static-video-${index}`} className="video-card">
                  <video
                    key={index}
                    src={`videos/travel${num}.mp4`}
                    muted
                    loop
                    playsInline
                    onMouseEnter={(e) => { e.target.play().catch(err => console.warn("Video playback prevented:", err)); }}
                    onMouseLeave={(e) => e.target.pause()}
                    style={{ width: '200px', height: '280px', objectFit: 'cover' }}
                  />
                  <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="action-btn" title="Edit Video"><Edit2 size={14} /></button>
                    <button className="action-btn delete" title="Delete Video"><Trash2 size={14} /></button>
                  </div>
                </div>
                ))
              )}
            </div>
          </div>

        </section>

        <section id="photography">
          <h2>Photography</h2>
          <section id="photography-inner">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>myCut</h2>
              <div>
                <label className={`upload-btn ${isUploadingPhoto ? 'disabled' : ''}`}>
                  <Plus size={14} />
                  <span>{isUploadingPhoto ? 'Uploading...' : 'Upload Photo'}</span>
                  <input type="file" accept="image/*" className="hidden-input" onChange={handlePhotoUpload} disabled={isUploadingPhoto} />
                </label>
              </div>
            </div>

            <div className="photo-grid">
              {photoData.length > 0 ? (
                photoData.map((item, index) => (
                  <div
                  className="photo-card"
                  key={index}
                  onClick={() => setActivePhoto({
                    ...item,
                    src: item.url.startsWith('images/') ? item.url : item.url.startsWith('http') ? item.url : `https://daily-demo-backend.vercel.app${item.url.startsWith('/') ? '' : '/'}${item.url}`
                  })}>
                    <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="action-btn"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const newTitle = prompt("修改图片名称:", item.title);
                          const newDesc = prompt("修改图片描述:", item.desc);
                          if (newTitle !== null || newDesc !== null) {
                            try {
                              const loginRes = await fetch('https://daily-demo-backend.vercel.app/api/auth/login', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ username: 'testuser', password: 'password123' })
                              });
                              const loginData = await loginRes.json();
                              await fetch(`https://daily-demo-backend.vercel.app/api/photos/${item.id}`, {
                                method: 'PUT',
                                headers: {
                                  'Content-Type': 'application/json',
                                  'Authorization': `Bearer ${loginData.token}`
                                },
                                body: JSON.stringify({ title: newTitle || item.title, desc: newDesc || item.desc, url: item.url })
                              });
                              setPhotoData(photoData.map(p => p.id === item.id ? { ...p, title: newTitle || item.title, desc: newDesc || item.desc } : p));
                            } catch (err) { console.error(err); }
                          }
                        }}
                        title="Edit Photo"
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        className="action-btn delete"
                        onClick={(e) => handleDeletePhoto(item.id, e)}
                        title="Delete Photo"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="photo-img-wrapper">
                      <img src={item.url.startsWith('images/') ? item.url : item.url.startsWith('http') ? item.url : `https://daily-demo-backend.vercel.app${item.url.startsWith('/') ? '' : '/'}${item.url}`} alt={item.title} />
                    </div>
                    <div className="photo-info">
                      <h3>{item.title}</h3>
                      <p>{item.desc}</p>
                    </div>
                  </div>
                ))
              ) : (
                [
                  { src: "images/photo1.jpg", title: "星星上开满了花", desc: "成都 · 2023" },
                  { src: "images/photo2.jpg", title: "平潭一角", desc: "平潭 · 2024" },
                  { src: "images/photo3.jpg", title: "嘿，抬头", desc: "成都 · 2023" },
                  { src: "images/photo4.jpg", title: "马里冷旧", desc: "峨眉 · 2024" },
                  { src: "images/photo5.jpg", title: "风车&海田", desc: "平潭 · 2024" },
                  { src: "images/photo6.jpg", title: "沉思", desc: "平潭 · 2024" },
                  { src: "images/photo7.jpg", title: "你看那边", desc: "平潭 · 2024" },
                  { src: "images/photo8.jpg", title: "风车", desc: "平潭 · 2024" },
                  { src: "images/photo9.jpg", title: "修狗们", desc: "成都 · 2022" },
                  { src: "images/photo10.jpg", title: "日落", desc: "成都 · 2023" },
                  { src: "images/photo11.jpg", title: "你谁？", desc: "成都 · 2018" },
                  { src: "images/photo12.jpg", title: "傍晚", desc: "昆明 · 2024" },
                  { src: "images/photo13.jpg", title: "群山", desc: "川西 · 2024" },
                  { src: "images/photo14.jpg", title: "矮油，不错哦", desc: "海口 · 2024" },
                  { src: "images/photo16.jpg", title: "氧气", desc: "川西 · 2024" },
                  { src: "images/photo17.jpg", title: "苍山浮在洱海上", desc: "大理 · 2024" },
                  { src: "images/photo18.jpg", title: "燥热的空气", desc: "海南某处 · 2024" },
                  { src: "images/photo19.jpg", title: "境", desc: "鱼子西 · 2024" },
                  { src: "images/photo20.jpg", title: "快拍", desc: "鱼子西 · 2024" },
                  { src: "images/photo21.jpg", title: "新疆？", desc: "随机点 · 2024" },
                  { src: "images/photo22.jpg", title: "门缝里看鸥", desc: "昆明 · 2024" },
                  { src: "images/photo23.jpg", title: "翠湖", desc: "昆明 · 2024" },
                  { src: "images/photo24.jpg", title: "下一秒即将开抢的牛仔", desc: "昆明 · 2024" },
                  { src: "images/photo25.jpg", title: "呔", desc: "昆明 · 2024" },
                  { src: "images/photo26.jpg", title: "你贵，但值", desc: "昆明 · 2024" },
                  { src: "images/photo27.jpg", title: "你见到小王子了吗", desc: "鱼子西 · 2024" },
                  { src: "images/photo28.jpg", title: "威猛猛兽_Ariza", desc: "成都 · 2024" },
                  { src: "images/photo29.jpg", title: "小家伙", desc: "成都 · 2024" },
                  { src: "images/photo30.jpg", title: "日出", desc: "鱼子西 · 2024" }
                ].map((item, index) => (
                  <div
                  className="photo-card"
                  key={index}
                  style={{ position: 'relative' }}
                  onClick={() => setActivePhoto(item)}>
                    <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="action-btn" title="Edit Photo"><Edit2 size={14} /></button>
                      <button className="action-btn delete" title="Delete Photo"><Trash2 size={14} /></button>
                    </div>
                    <div className="photo-img-wrapper">
                      <img src={item.src} alt={item.title} />
                    </div>
                    <div className="photo-info" style={{ position: 'relative' }}>
                      <h3>{item.title}</h3>
                      <p>{item.desc}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
          {activePhoto && (
            <div className="lightbox" onClick={() => setActivePhoto(null)}>
              <div
                className="lightbox-content"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="lightbox-close"
                  onClick={() => setActivePhoto(null)}
                >
                  ×
                </button>

                <img src={activePhoto.src} alt={activePhoto.title} />

                <div className="lightbox-caption">
                  <h3>{activePhoto.title}</h3>
                  <p>{activePhoto.desc}</p>
                </div>
              </div>
            </div>
          )}
        </section>

        <section id="links">
          <h2>Links</h2>
          <ul className="links">
            <li>
              <Mail size={16} />
              <a href="mailto:zhou.1900@jiyunhudong.com">
                zhou.1900@jiyunhudong.com
              </a>
            </li>
            <li>
              <ExternalLink size={16} />
              <a href="https://v.douyin.com/VWYUIrtxV2Y/" target="_blank">
                Douyin
              </a>
            </li>
            <li>
              <ExternalLink size={16} />
              <a href="https://www.douban.com/people/269994208/" target="_blank">
                Douban
              </a>
            </li>
            <li>
              <ExternalLink size={16} />
              <a href="https://xhslink.com/m/39qXQZqVMys" target="_blank">
                Xiaohongshu
              </a>
            </li>
          </ul>
        </section>

      </main>
    </div>
  )
  
}
