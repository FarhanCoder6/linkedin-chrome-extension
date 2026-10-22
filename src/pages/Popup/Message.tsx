import React, { useEffect, useState } from 'react'

const Message = () => {
  const [status, setStatus] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [savedata, setSavedata] = useState(false)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    const handler = (message: unknown) => {
      if (!message || typeof message !== 'object') {
        return
      }

      const payload = message as { type?: string; status?: string; count?: number; error?: string }
      if (payload.type !== 'CARD_TAGS_STATUS') {
        return
      }

      if (payload.status === 'saved') {
        setStatus(`Saved ${payload.count ?? 0} cards`)
        setSavedata(true)
        return
      }

      if (payload.status === 'cleared') {
        setStatus('All saved data deleted')
        setSavedata(false)
        return
      }

      if (payload.status === 'failed') {
        setStatus(`Save failed: ${payload.error ?? 'unknown error'}`)
        setSavedata(false)
      }
    }

    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  const sendToActiveLinkedInTab = (message: { type: string; query?: string }) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0]
      if (!activeTab?.id) {
        setStatus('Open a LinkedIn tab first')
        return
      }

      chrome.tabs.sendMessage(activeTab.id, message, () => {
        if (chrome.runtime.lastError) {
          setStatus('Open LinkedIn messages page, then try again')
        }
      })
    })
  }

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value
    setSearchQuery(query)
    sendToActiveLinkedInTab({ type: 'FILTER_PROFILES', query })
  }

  const handleShowAll = () => {
    setSearchQuery('')
    sendToActiveLinkedInTab({ type: 'FILTER_PROFILES', query: '' })
  }

  const handleOpenClearModal = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setShowModal(true)
  }

  const handleConfirmClear = () => {
    sendToActiveLinkedInTab({ type: 'CLEAR_CARD_TAGS' })
    setShowModal(false)
    setSavedata(false)
  }

  return (
    <div
      className='Main-div'
      style={{
        position: 'relative'
      }}
      onClick={() => {
        if (showModal) {
          setShowModal(false)
        }
      }}
    >
      <p>Linkdon Message</p>

      <div className='buttonMessage'>
        <button onClick={handleShowAll}>All</button>
        <button onClick={() => sendToActiveLinkedInTab({ type: 'SAVE_CARD_TAGS' })}>save data</button>
        <button onClick={handleOpenClearModal}>clear data</button>
      </div>

      {savedata && (
        <div
          onClick={() => setSavedata(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            padding: '8px 12px',
            borderRadius: '8px',
            background: '#f0faf4',
            border: '1px solid #c3e6cb',
            cursor: 'pointer',
            marginTop: '8px',
            animation: 'fadeIn 0.3s ease'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                color: '#ffffff',
                fontSize: '10px',
                background: '#1a6b3a',
                padding: '4px 4px',
                borderRadius: '50%',
                lineHeight: 1
              }}
            >
              <i className='fa-solid fa-check'></i>
            </span>
            <span style={{ color: '#1a6b3a', fontSize: '13px', fontWeight: 600 }}>Successfully saved data</span>
          </div>
          <span style={{ color: '#9aa6b2', fontSize: '11px' }}>✕</span>
        </div>
      )}

      {showModal && (
        <div
          style={{
            position: 'absolute',
            inset: '0',
            background: 'rgba(0, 0, 0, 0.15)',
            backdropFilter: 'blur(2px)',
            zIndex: 999
          }}
        />
      )}

{showModal && (
        <div
          onClick={(event) => event.stopPropagation()}
          style={{
            marginTop: '8px',
            background: '#ffffff',
            border: '1px solid #e8eef6',
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: '0 10px 24px rgba(0,0,0,0.12)',
            width:'70%',
            zIndex: 1000,
            position:'absolute',
            top:'45%',
            left:'50%',
            transform:'translate(-50%,-50%)',
          }}
        >
          <div
            style={{
              width: '100%',
            }}
          >
            <div style={{ padding: '14px 12px 12px', textAlign: 'center' }}>
              <h3 style={{ fontSize: '14px', fontWeight: '700', marginBottom: '6px', color: '#1f2328' }}>
                Clear saved data?
              </h3>
              <p style={{ fontSize: '12px', color: '#6b7280', lineHeight: 1.4 }}>
                All saved card tags will be deleted.
              </p>
            </div>
            
            <div style={{ height: '1px', background: '#e8eef6' }} ></div>

            <div style={{ display: 'flex' }}>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  flex: 1,
                  padding: '10px',
                  border: 'none',
                  background: 'none',
                  fontSize: '13px',
                  color: '#6b7280',
                  cursor: 'pointer',
                  fontWeight: '600'
                }}
              >
                Cancel
              </button>

              <div style={{ width: '1px', background: '#e8eef6' }} />

              <button
                onClick={handleConfirmClear}
                style={{
                  flex: 1,
                  padding: '10px',
                  border: 'none',
                  background: 'none',
                  fontSize: '13px',
                  color: '#1f2328',
                  cursor: 'pointer',
                  fontWeight: '700'
                }}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      <div className='inputbox'>
        <i className='fa-solid fa-magnifying-glass search-icon'></i>
        <input type='text' placeholder='Search....' value={searchQuery} onChange={handleSearchChange} />
        {searchQuery && (
          <button type='button' className='clear-search-btn' onClick={handleShowAll} aria-label='Clear search'>
            <i className='fa-solid fa-xmark'></i>
          </button>
        )}
      </div>

      {/* {status && <p style={{ marginTop: '8px', fontSize: '12px', color: '#6b7280' }}>{status}</p>} */}
    </div>
  )
}

export default Message
