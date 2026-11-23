# **Business Manager POS**

A desktop application for managing point-of-sale operations and inventory, built with Electron and SQLite.

## **Features**

- Record sales and manage products and inventory.
- Manage customers, suppliers, expenses, and checks.
- View sales, profit, and inventory reports.
- Support for Arabic, French, English, and Spanish.
- Store the database and backups locally on the user's device.

## **Requirements**

- [Node.js](https://nodejs.org/?utm_source=chatgpt.com) and npm.
- Windows, Linux, or macOS to run the application locally.

## **Installation and Setup**

From the project directory, run:

```
npm install
npm start
```

On Windows, you can also run `setup.bat` to install dependencies.

## **Build Commands**

```
npm run build        # Build for the current platform
npm run build:win   # Build for Windows
npm run build:linux # Build for Linux
npm run build:mac   # Build for macOS
```

To build the Windows version using Docker on Linux:

```
bash docker-build-win.sh
```

The generated build files are saved in `dist/`, which is excluded from Git.

## **Application Data**

The SQLite database and backups are stored locally in the application's user data directory on the device. Runtime data and backup files should not be uploaded to the repository.
