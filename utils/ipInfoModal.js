// The IP information popup, shared by the IP Timeseries and Rate Limit Status pages: styles, markup and
// a script defining fetchIpInfo(ip), which fills the popup from /iptimeseries/lookup/:ip (routes/iptimeseries.js).
// Classes are prefixed (ip-modal-…) so they don't clash with a page's own .modal / .close / .loading.
// Values from the lookup service go in as text, never as markup.

const IP_MODAL_STYLES = `
            .ip-modal {
              display: none;
              position: fixed;
              z-index: 1000;
              left: 0;
              top: 0;
              width: 100%;
              height: 100%;
              overflow: auto;
              background-color: rgba(0,0,0,0.5);
            }
            .ip-modal-content {
              background-color: #fefefe;
              margin: 5% auto;
              padding: 20px;
              border: 1px solid #888;
              border-radius: 8px;
              width: 80%;
              max-width: 600px;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            }
            .ip-modal-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 20px;
              border-bottom: 2px solid #f0f0f0;
              padding-bottom: 10px;
            }
            .ip-modal-header h2 {
              margin: 0;
              color: #333;
            }
            .ip-modal-close {
              color: #aaa;
              font-size: 28px;
              font-weight: bold;
              cursor: pointer;
              line-height: 20px;
            }
            .ip-modal-close:hover,
            .ip-modal-close:focus {
              color: #000;
            }
            .ip-modal-body {
              color: #333;
            }
            .ip-info-table {
              width: 100%;
              border-collapse: collapse;
            }
            .ip-info-table td {
              padding: 10px;
              border-bottom: 1px solid #f0f0f0;
            }
            .ip-info-table td:first-child {
              font-weight: bold;
              width: 40%;
              color: #666;
            }
            .ip-modal-loading {
              text-align: center;
              padding: 20px;
              color: #666;
            }
`;

const IP_MODAL_MARKUP = `
          <!-- IP Info Modal -->
          <div id="ipModal" class="ip-modal">
            <div class="ip-modal-content">
              <div class="ip-modal-header">
                <h2>IP Information</h2>
                <span class="ip-modal-close" id="ipModalClose">&times;</span>
              </div>
              <div class="ip-modal-body" id="modalBody">
                <div class="ip-modal-loading">Loading...</div>
              </div>
            </div>
          </div>
`;

const IP_MODAL_SCRIPT = `
            // IP information popup (utils/ipInfoModal.js)
            const ipModal = document.getElementById('ipModal');
            const ipModalBody = document.getElementById('modalBody');

            function escapeText(value) {
              return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
            }

            async function fetchIpInfo(ip) {
              try {
                ipModalBody.innerHTML = '<div class="ip-modal-loading">Loading...</div>';
                ipModal.style.display = 'block';
                const response = await fetch('/iptimeseries/lookup/' + encodeURIComponent(ip));
                if (!response.ok) {
                  throw new Error('Failed to fetch IP information');
                }
                displayIpInfo(await response.json());
              } catch (error) {
                ipModalBody.innerHTML = '<div class="ip-modal-loading" style="color: red;">Error: ' + escapeText(error.message) + '</div>';
              }
            }

            function displayIpInfo(data) {
              const fields = [
                { key: 'query', label: 'IP Address' },
                { key: 'country', label: 'Country' },
                { key: 'countryCode', label: 'Country Code' },
                { key: 'region', label: 'Region' },
                { key: 'regionName', label: 'Region Name' },
                { key: 'city', label: 'City' },
                { key: 'zip', label: 'Zip Code' },
                { key: 'lat', label: 'Latitude' },
                { key: 'lon', label: 'Longitude' },
                { key: 'timezone', label: 'Timezone' },
                { key: 'isp', label: 'ISP' },
                { key: 'org', label: 'Organization' },
                { key: 'as', label: 'AS Number' },
                { key: 'mobile', label: 'Mobile' },
                { key: 'proxy', label: 'Proxy' },
                { key: 'hosting', label: 'Hosting' }
              ];
              let html = '<table class="ip-info-table">';
              fields.forEach(field => {
                const value = data[field.key];
                if (value !== undefined && value !== null && value !== '') {
                  const displayValue = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
                  html += '<tr><td>' + field.label + '</td><td>' + escapeText(displayValue) + '</td></tr>';
                }
              });
              html += '</table>';
              ipModalBody.innerHTML = html;
            }

            function closeIpModal() {
              ipModal.style.display = 'none';
            }
            document.getElementById('ipModalClose').onclick = closeIpModal;
            window.onclick = function(event) {
              if (event.target === ipModal) closeIpModal();
            };
            document.addEventListener('keydown', function(event) {
              if (event.key === 'Escape' && ipModal.style.display === 'block') closeIpModal();
            });
`;

module.exports = { IP_MODAL_STYLES, IP_MODAL_MARKUP, IP_MODAL_SCRIPT };
