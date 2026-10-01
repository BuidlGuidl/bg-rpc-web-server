// Browser code shared by the IP and Origin Timeseries pages. A page inlines it as
// `(${timeseriesClient.toString()})(config)` and gets back { rerender, payload }.
//
// One Plotly chart of the top 30 series (data from utils/edgeTimeseries.js), the hour in progress
// as dotted lines from each series' last completed hour, redrawn in place once a minute; the day
// buttons switch the window without a reload; a status line shows the data's time, failed updates
// and an expired login; a hidden tab doesn't poll. Hovering a line or legend entry highlights it.
//
// config: {
//   plotId, statusId, dataPath, pagePath, initialPayload,
//   values(series) -> y values per hour, liveValue(liveEntry) -> y for the hour in progress,
//   scaleValues(series) / scaleLiveValue(liveEntry): what the default y range covers,
//   onLegendClick(series, payload)
// }
function timeseriesClient(config) {
  const HOUR_MS = 60 * 60 * 1000;
  const REFRESH_MS = 60 * 1000;
  const colors = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
    '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5',
    '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5',
    '#e377c2', '#7f7f7f', '#bcbd22', '#17becf', '#1f77b4',
    '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b'
  ];
  const plotElement = document.getElementById(config.plotId);

  let payload = config.initialPayload;
  let traces = [];        // as drawn; trace.seriesIndex maps a curve back to its series
  let userX = null;       // ranges set by zooming or panning by hand, kept across refreshes
  let userY = null;
  let latestRequest = 0;
  let refreshTimer = null;
  let sessionExpired = false;

  // Series names come from callers (origins): never as markup in hover text
  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function utcTime(ms) {
    return new Date(ms).toISOString().slice(11, 19);
  }

  function setStatus(text, isProblem) {
    const status = document.getElementById(config.statusId);
    status.textContent = text;
    status.classList.toggle('problem', Boolean(isProblem));
  }

  function markDayButtons() {
    document.querySelectorAll('.time-filter-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.getAttribute('data-days')) === payload.days);
    });
  }

  function buildTraces() {
    const built = [];
    const hours = payload.hours;
    payload.series.forEach((series, index) => {
      const values = config.values(series);
      built.push({
        name: series.key,
        x: hours,
        y: values,
        type: 'scatter',
        mode: 'lines+markers',
        line: { color: colors[index % colors.length], width: 3 },
        marker: { size: values.map(count => count > 0 ? 12 : 0), symbol: index < 10 ? 'circle' : index < 20 ? 'square' : 'diamond' },
        hovertemplate: '<b>' + escapeText(series.key) + '</b><br>Request units: %{y}<extra></extra>',
        seriesIndex: index
      });
    });

    // The hour in progress: dotted, from each series' last completed hour to its count so far
    if (payload.live) {
      const liveTime = new Date(payload.live.hour).getTime();
      const lastHour = hours[hours.length - 1];
      const joins = lastHour && new Date(lastHour).getTime() === liveTime - HOUR_MS;
      const minutes = Math.max(0, Math.floor((payload.asOf - liveTime) / 60000));
      payload.series.forEach((series, index) => {
        const value = config.liveValue(payload.live.byKey[series.key]);
        const values = config.values(series);
        const x = joins ? [lastHour, payload.live.hour] : [payload.live.hour];
        const y = joins ? [values[values.length - 1], value] : [value];
        const text = joins ? [y[0] + ' (full hour)', value + ' so far (' + minutes + ' min into the hour)'] : [value + ' so far (' + minutes + ' min into the hour)'];
        built.push({
          name: series.key + ' (hour in progress)',
          x: x,
          y: y,
          text: text,
          type: 'scatter',
          mode: 'lines+markers',
          showlegend: false,
          line: { color: colors[index % colors.length], width: 3, dash: 'dot' },
          marker: { size: y.map((count, i) => (i === y.length - 1 && count > 0) ? 12 : 0), symbol: index < 10 ? 'circle' : index < 20 ? 'square' : 'diamond' },
          hovertemplate: '<b>' + escapeText(series.key) + '</b><br>%{text}<extra></extra>',
          seriesIndex: index
        });
      });
    }
    return built;
  }

  function defaultRanges() {
    const hours = payload.hours;
    const end = payload.live ? payload.live.hour : hours[hours.length - 1];
    let maxY = 0;
    payload.series.forEach(series => {
      config.scaleValues(series).forEach(v => { if (v > maxY) maxY = v; });
      if (payload.live) maxY = Math.max(maxY, config.scaleLiveValue(payload.live.byKey[series.key]));
    });
    return { x: [hours[0], end], y: [0, maxY * 1.02 || 1] };
  }

  function render() {
    traces = buildTraces();
    const ranges = defaultRanges();
    const layout = {
      xaxis: { title: 'Time (UTC)', type: 'date', showgrid: true, range: userX || ranges.x },
      yaxis: { title: 'Request Units', showgrid: true, range: userY || ranges.y },
      hovermode: 'closest',
      showlegend: true,
      legend: { orientation: 'v', x: 1.02, y: 1, xanchor: 'left', yanchor: 'top', itemclick: false, itemdoubleclick: false },
      margin: { l: 60, r: 200, t: 80, b: 60 }
    };
    markDayButtons();
    setStatus(payload.series.length
      ? 'Data as of ' + utcTime(payload.asOf) + ' UTC, refreshes every minute'
      : 'No data in this window. Refreshes every minute.');
    return Plotly.react(config.plotId, traces, layout);
  }

  // Highlight one series (its completed hours and its hour in progress), or none
  function highlight(seriesIndex) {
    Plotly.restyle(config.plotId, {
      'line.width': traces.map(t => t.seriesIndex === seriesIndex ? 6 : 3),
      'opacity': traces.map(t => seriesIndex === null || t.seriesIndex === seriesIndex ? 1.0 : 0.3),
      'marker.size': traces.map(t => t.marker.size.map(size => size === 0 ? 0 : (t.seriesIndex === seriesIndex ? 18 : 12)))
    });
  }

  // The legend entry an event happened in (index = series index; hour-in-progress lines have none)
  function legendIndex(target) {
    const item = target && target.closest ? target.closest('g.traces') : null;
    if (!item || !item.closest('.legend')) return -1;
    return Array.prototype.indexOf.call(plotElement.querySelectorAll('.legend g.traces'), item);
  }

  async function load() {
    const request = ++latestRequest;
    try {
      const response = await fetch(config.dataPath + '?days=' + payload.days, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
      const type = response.headers.get('content-type') || '';
      if (response.redirected || !type.includes('application/json')) {
        sessionExpired = true;
        stopRefresh();
        setStatus('Session expired: reload the page to log in again.', true);
        return;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const next = await response.json();
      if (request !== latestRequest) return; // a newer request (another window) was sent meanwhile
      payload = next;
      await render();
    } catch (error) {
      if (request === latestRequest) {
        setStatus('Update failed at ' + utcTime(Date.now()) + ' UTC (' + error.message + '), retrying every minute.', true);
      }
    }
  }

  function startRefresh() {
    if (!refreshTimer && !sessionExpired) refreshTimer = setInterval(load, REFRESH_MS);
  }

  function stopRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  // ---- interactions, attached once (they survive redraws).
  // Plotly's events: the div only gets .on() once Plotly has drawn into it, so after the first draw
  function attachPlotlyEvents() {
    plotElement.on('plotly_relayout', eventData => {
      if (eventData['xaxis.range[0]'] !== undefined) userX = [eventData['xaxis.range[0]'], eventData['xaxis.range[1]']];
      if (eventData['yaxis.range[0]'] !== undefined) userY = [eventData['yaxis.range[0]'], eventData['yaxis.range[1]']];
      if (eventData['xaxis.autorange']) userX = null;
      if (eventData['yaxis.autorange']) userY = null;
    });
    plotElement.on('plotly_hover', data => highlight(traces[data.points[0].curveNumber].seriesIndex));
    plotElement.on('plotly_unhover', () => highlight(null));
  }
  // Legend hover and clicks: plain DOM events on the container
  plotElement.addEventListener('mouseover', event => {
    const index = legendIndex(event.target);
    if (index >= 0) highlight(index);
  });
  plotElement.addEventListener('mouseout', event => {
    if (legendIndex(event.target) >= 0) highlight(null);
  });
  plotElement.addEventListener('click', event => {
    const index = legendIndex(event.target);
    if (index >= 0 && payload.series[index]) {
      event.preventDefault();
      event.stopPropagation();
      config.onLegendClick(payload.series[index], payload);
    }
  });

  // Day buttons: switch the window in place; the URL follows so a reload keeps it
  document.querySelectorAll('.time-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.getAttribute('data-days'));
      payload = Object.assign({}, payload, { days: days });
      userX = null;
      userY = null;
      markDayButtons();
      setStatus('Loading ' + btn.textContent + '...');
      history.replaceState(null, '', config.pagePath + '?days=' + days);
      load();
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopRefresh();
    } else if (!sessionExpired) {
      load();
      startRefresh();
    }
  });

  render().then(attachPlotlyEvents);
  startRefresh();

  return {
    // redraw from the current data (a page-level filter changed)
    rerender: () => render(),
    payload: () => payload
  };
}

module.exports = { timeseriesClient };
