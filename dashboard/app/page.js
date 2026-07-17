'use client';

import { useEffect, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

export default function Dashboard() {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    supabase
      .from('incidents')
      .select('*')
      .order('last_seen', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('[dashboard] initial fetch failed', error);
        setIncidents(data || []);
        setLoading(false);
      });

    const channel = supabase
      .channel('incidents-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'incidents' },
        (payload) => {
          setIncidents((prev) => {
            if (payload.eventType === 'DELETE') {
              return prev.filter((row) => row.id !== payload.old.id);
            }
            const next = prev.filter((row) => row.id !== payload.new.id);
            next.unshift(payload.new);
            next.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
            return next;
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  if (loading) return <p>Loading…</p>;

  if (!isSupabaseConfigured) {
    return (
      <main>
        <h1>Incidents</h1>
        <p>
          Dashboard configuration is missing. Set NEXT_PUBLIC_SUPABASE_URL and
          NEXT_PUBLIC_SUPABASE_ANON_KEY, then rebuild the dashboard.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Incidents</h1>
      <table cellPadding={8} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
            <th>Service</th>
            <th>Error type</th>
            <th>Fingerprint</th>
            <th>Alert count</th>
            <th>Status</th>
            <th>Ticket</th>
            {incidents.some((i) => i.pr_url) && <th>PR</th>}
          </tr>
        </thead>
        <tbody>
          {incidents.map((incident) => (
            <tr key={incident.id} style={{ borderBottom: '1px solid #eee' }}>
              <td>{incident.service}</td>
              <td>{incident.error_type}</td>
              <td style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
                {incident.fingerprint.slice(0, 12)}…
              </td>
              <td>{incident.alert_count}</td>
              <td>{incident.status}</td>
              <td>
                {incident.ticket_url ? (
                  <a href={incident.ticket_url} target="_blank" rel="noreferrer">
                    issue
                  </a>
                ) : (
                  '—'
                )}
              </td>
              {incidents.some((i) => i.pr_url) && (
                <td>
                  {incident.pr_url ? (
                    <a href={incident.pr_url} target="_blank" rel="noreferrer">
                      PR
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
