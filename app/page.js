'use client';

import { useState } from 'react';

export default function Home() {
    const [formData, setFormData] = useState({
        address: '',
        date: '',
        chain: 'ethereum',
        network: 'mainnet',
        tokenAddress: ''
    });
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    const handleChange = (e) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const setCurrentTime = () => {
        const now = new Date();
        const localIso = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
        setFormData(prev => ({ ...prev, date: localIso }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setResult(null);

        // Convert local time to UTC before sending
        const payload = { ...formData };
        if (payload.date) {
            payload.date = new Date(payload.date).toISOString();
        }

        try {
            const res = await fetch('/api/balance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Failed to fetch balance');
            }

            setResult(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <main className="container">
            <div className="card">
                <h1>Wallet Time Machine</h1>

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="address">Wallet Address</label>
                        <input
                            id="address"
                            name="address"
                            type="text"
                            placeholder="0x..."
                            required
                            value={formData.address}
                            onChange={handleChange}
                        />
                    </div>

                    <div className="form-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <label htmlFor="date" style={{ marginBottom: 0 }}>Date & Time (Local)</label>
                            <button
                                type="button"
                                onClick={setCurrentTime}
                                style={{
                                    width: 'auto',
                                    padding: '0.25rem 0.75rem',
                                    fontSize: '0.875rem',
                                    background: 'transparent',
                                    color: 'var(--primary)',
                                    border: '1px solid var(--primary)',
                                    borderRadius: '6px',
                                    fontWeight: 500
                                }}
                            >
                                Set to Now
                            </button>
                        </div>
                        <input
                            id="date"
                            name="date"
                            type="datetime-local"
                            required
                            value={formData.date}
                            onChange={handleChange}
                        />
                        <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.25rem', textAlign: 'right' }}>
                            Timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        <div className="form-group">
                            <label htmlFor="chain">Chain</label>
                            <select
                                id="chain"
                                name="chain"
                                value={formData.chain}
                                onChange={(e) => {
                                    // Reset network when chain changes
                                    const newChain = e.target.value;
                                    let defaultNetwork = 'mainnet';
                                    if (newChain === 'tron') defaultNetwork = 'mainnet';
                                    setFormData({ ...formData, chain: newChain, network: defaultNetwork });
                                }}
                            >
                                <option value="ethereum">Ethereum</option>
                                <option value="polygon">Polygon</option>
                                <option value="bsc">BSC</option>
                                <option value="tron">Tron</option>
                            </select>
                        </div>

                        <div className="form-group">
                            <label htmlFor="network">Network</label>
                            <select
                                id="network"
                                name="network"
                                value={formData.network}
                                onChange={handleChange}
                            >
                                <option value="mainnet">Mainnet</option>
                                {formData.chain === 'ethereum' && <option value="sepolia">Sepolia</option>}
                                {formData.chain === 'polygon' && <option value="amoy">Amoy</option>}
                                {formData.chain === 'bsc' && <option value="testnet">Testnet</option>}
                                {formData.chain === 'tron' && <option value="shasta">Shasta</option>}
                            </select>
                        </div>            </div>

                    <div className="form-group">
                        <label htmlFor="tokenAddress">Token Address (Optional)</label>
                        <input
                            id="tokenAddress"
                            name="tokenAddress"
                            type="text"
                            placeholder="Leave empty for native balance"
                            value={formData.tokenAddress}
                            onChange={handleChange}
                        />
                    </div>

                    <button type="submit" disabled={loading}>
                        {loading ? <div className="spinner"></div> : 'Check Balance'}
                    </button>
                </form>

                {error && <div className="error">{error}</div>}

                {result && (
                    <div className="result">
                        <div className="result-item">
                            <span className="result-label">Balance</span>
                            <span className="result-value">{result.balance} {result.symbol}</span>
                        </div>
                        <div className="result-item">
                            <span className="result-label">Block Number</span>
                            <span className="result-value">#{result.blockNumber}</span>
                        </div>
                        <div className="result-item">
                            <span className="result-label">Timestamp</span>
                            <span className="result-value">{new Date(result.timestamp * 1000).toLocaleString('en-GB')}</span>
                        </div>
                    </div>
                )}
            </div>
        </main>
    );
}
