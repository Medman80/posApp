const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Products
  getProducts: (search) => ipcRenderer.invoke('get-products', search),
  addProduct: (product) => ipcRenderer.invoke('add-product', product),
  updateProduct: (product) => ipcRenderer.invoke('update-product', product),
  deleteProduct: (id) => ipcRenderer.invoke('delete-product', id),
  getLowStock: () => ipcRenderer.invoke('get-low-stock'),
  getProductQr: (productId, lang) => ipcRenderer.invoke('get-product-qr', productId, lang),
  getGeneralQr: (lang) => ipcRenderer.invoke('get-general-qr', lang),
  getProductImages: (productId) => ipcRenderer.invoke('get-product-images', productId),

  // Sales
  createSale: (sale) => ipcRenderer.invoke('create-sale', sale),
  getSales: (filters) => ipcRenderer.invoke('get-sales', filters),
  getSaleItems: (saleId) => ipcRenderer.invoke('get-sale-items', saleId),
  cancelSale: (saleId) => ipcRenderer.invoke('cancel-sale', saleId),
  cancelSaleItem: (itemId) => ipcRenderer.invoke('cancel-sale-item', itemId),

  // Customers
  getCustomers: (search) => ipcRenderer.invoke('get-customers', search),
  addCustomer: (customer) => ipcRenderer.invoke('add-customer', customer),
  updateCustomer: (customer) => ipcRenderer.invoke('update-customer', customer),
  deleteCustomer: (id) => ipcRenderer.invoke('delete-customer', id),
  payCustomerCredit: (data) => ipcRenderer.invoke('pay-customer-credit', data),

  // Expenses
  getExpenses: (filters) => ipcRenderer.invoke('get-expenses', filters),
  addExpense: (expense) => ipcRenderer.invoke('add-expense', expense),
  deleteExpense: (id) => ipcRenderer.invoke('delete-expense', id),

  // Suppliers
  getSuppliers: (search) => ipcRenderer.invoke('get-suppliers', search),
  addSupplier: (supplier) => ipcRenderer.invoke('add-supplier', supplier),
  updateSupplier: (supplier) => ipcRenderer.invoke('update-supplier', supplier),
  deleteSupplier: (id) => ipcRenderer.invoke('delete-supplier', id),

  // Reports & Dashboard
  getDashboardStats: () => ipcRenderer.invoke('get-dashboard-stats'),
  getSalesReport: (params) => ipcRenderer.invoke('get-sales-report', params),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Export
  exportData: (params) => ipcRenderer.invoke('export-data', params),
  exportPdf: (params) => ipcRenderer.invoke('export-pdf', params),
  
  // Checks
  getChecks: (search) => ipcRenderer.invoke('get-checks', search),
  addCheck: (check) => ipcRenderer.invoke('add-check', check),
  updateCheck: (check) => ipcRenderer.invoke('update-check', check),
  deleteCheck: (id) => ipcRenderer.invoke('delete-check', id),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  navigateToMain: () => ipcRenderer.invoke('navigate-to-main'),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  printSilent: (options) => ipcRenderer.invoke('print-silent', options),
  printHtml: (params) => ipcRenderer.invoke('print-html', params),
});
