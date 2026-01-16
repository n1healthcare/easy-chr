import { useState, useRef } from 'react'
import './App.css'

interface RealmEvent {
  type: 'step' | 'log' | 'stream' | 'result' | 'error'
  name?: string
  status?: string
  message?: string
  content?: string
  url?: string
  error?: string
}

function App() {
  const [files, setFiles] = useState<File[]>([])
  const [prompt, setPrompt] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  
  // Rotating Thought State
  const [currentStep, setCurrentStep] = useState<string>('Initializing...')
  const [currentLog, setCurrentLog] = useState<string>('')
  const [streamBuffer, setStreamBuffer] = useState<string>('')
  
  const [realmUrl, setRealmUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files
    if (selectedFiles) {
      setFiles(prev => [...prev, ...Array.from(selectedFiles)])
      setError(null)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.files) {
      setFiles(prev => [...prev, ...Array.from(e.dataTransfer.files)])
      setError(null)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (files.length === 0 || isGenerating || !prompt.trim()) return

    setIsGenerating(true)
    setError(null)
    setRealmUrl(null)
    
    // Reset Thought State
    setCurrentStep('Initializing...')
    setCurrentLog('Uploading files...')
    setStreamBuffer('')

    const formData = new FormData()
    files.forEach((file) => {
      formData.append('files', file)
    })
    formData.append('prompt', prompt || 'Visualize these documents')

    try {
      const response = await fetch('/api/realm', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`Server error: ${response.statusText}`)
      }

      if (!response.body) throw new Error('No response body')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() || '' 

        for (const block of blocks) {
          const lines = block.split('\n')
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              eventData = line.substring(6)
            }
          }

          if (eventData) {
            try {
              const parsedData: RealmEvent = JSON.parse(eventData)
              
              if (parsedData.type === 'step') {
                if (parsedData.status === 'running') {
                  setCurrentStep(parsedData.name || 'Processing...')
                  setStreamBuffer('') // Clear stream on new step
                }
              } else if (parsedData.type === 'log') {
                setCurrentLog(parsedData.message || '')
              } else if (parsedData.type === 'stream') {
                // For stream, we append, but maybe limit length so it doesn't crash DOM?
                // Or just show last N chars?
                // User said "thinking should be rotating", but for stream (HTML generation),
                // it's fun to see it type out.
                setStreamBuffer(prev => (prev + (parsedData.content || '')).slice(-500)) 
              } else if (parsedData.type === 'result') {
                setRealmUrl(parsedData.url || null)
                setIsGenerating(false)
              } else if (parsedData.error) {
                throw new Error(parsedData.error)
              }
            } catch (e) {
              console.error('Failed to parse SSE data', e)
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Error:', error)
      setError(error.message || 'Failed to generate realm')
      setIsGenerating(false)
    }
  }

  // Auto-scroll logic if we were showing a log list, but here we just show single items.
  // However, stream buffer might grow.

  if (realmUrl) {
    return (
      <div className="fullscreen-layout success-mode">
        <div className="center-content">
          <div className="success-card">
            <div className="success-icon">✨</div>
            <h1>Realm Ready</h1>
            <p>Your immersive experience has been generated.</p>
            <div className="actions">
              <a href={realmUrl} target="_blank" rel="noopener noreferrer" className="primary-btn">
                Enter Realm
              </a>
              <button className="secondary-btn" onClick={() => setRealmUrl(null)}>
                Create New
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fullscreen-layout">
      {/* Header / Brand */}
      <header className="app-header">
        <div className="logo">N1 Interface</div>
      </header>

      {/* Main Content Grid */}
      <main className="main-grid">
        
        {/* Left Column: Files */}
        <section className="file-section">
          <div 
            className={`drop-zone ${files.length === 0 ? 'empty' : 'populated'}`}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input 
              ref={fileInputRef}
              type="file" 
              onChange={handleFileChange} 
              accept=".pdf,.txt,.csv,.md,.png,.jpg,.jpeg"
              multiple
              hidden
            />
            
            {files.length === 0 ? (
              <div className="drop-message">
                <span className="icon">📂</span>
                <h3>Upload Documents</h3>
                <p>Drag & drop or click to browse</p>
              </div>
            ) : (
              <div className="file-grid">
                {files.map((f, i) => (
                  <div key={i} className="file-card">
                    <div className="file-icon">📄</div>
                    <div className="file-info">
                      <span className="file-name">{f.name}</span>
                      <span className="file-size">{(f.size / 1024).toFixed(1)} KB</span>
                    </div>
                  </div>
                ))}
                <div className="add-more-card">
                  <span>+ Add More</span>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Right Column: Prompt & Action */}
        <section className="input-section">
          <div className="prompt-container">
            <label htmlFor="prompt">Objective</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want to extract or visualize from these documents..."
              disabled={isGenerating}
            />
          </div>

          <div className="action-container">
            {error && <div className="error-banner">{error}</div>}
            
            {!isGenerating ? (
              <button 
                className="generate-btn"
                onClick={handleSubmit}
                disabled={files.length === 0 || !prompt.trim()}
              >
                Generate Realm
              </button>
            ) : (
              <div className="thought-display">
                <div className="thought-header">
                  <span className="spinner"></span>
                  <span className="step-name">{currentStep}</span>
                </div>
                <div className="thought-content">
                  {/* Priority: Stream Buffer (if active) > Current Log */}
                  {streamBuffer ? (
                    <span className="stream-text">...{streamBuffer}</span>
                  ) : (
                    <span className="log-text">{currentLog}</span>
                  )}
                  <span className="cursor">|</span>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
