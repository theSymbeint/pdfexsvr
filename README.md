# pdfexsvr

## Project Overview

**pdfexsvr** is a Node.js/TypeScript server for generating PDFs dynamically based on templates and user data. It exposes HTTP endpoints for creating, storing, and rendering PDF documents, with user authentication and template management handled via a PocketBase backend.

---

## Key Features

- **PDF Generation:** Uses `pdfkit` to generate PDFs from JSON-based templates and user data.
- **API Endpoints:** Provides RESTful endpoints for:
  - Creating a print token (stores template/data for later PDF generation)
  - Generating a PDF from a template and token
  - Testing PDF generation with sample data
- **Template System:** Templates define pages, fonts, images, shapes, labels, and data fields for dynamic PDF creation.
- **Authentication:** Uses API keys and PocketBase for user and template access control.
- **Static File Serving:** Serves static files from a `public` directory.
- **Healthcheck:** Simple endpoint to verify server status.

---

## Main Technologies

- **Node.js** with **TypeScript**
- **Hono** (web framework)
- **pdfkit** (PDF generation)
- **PocketBase** (backend database for users, templates, tokens)
- **Docker** (for containerization)
- **formidable** (for file uploads, if needed)
- **node-fetch** (for fetching remote resources)

---

## Project Structure

- `src/index.ts`: Main entry point. Sets up the Hono server, middleware, static file serving, and routes.
- `src/app/pdf.routes.ts`: Defines all PDF-related API endpoints.
- `src/lib/pdf.builder.ts`: Core logic for building PDFs from templates and data.
- `src/lib/types/`: Type definitions for templates, fonts, etc.
- `src/lib/db/pb.ts`: PocketBase client initialization.
- `src/data/template.data.ts`: Example template and data for testing.
- `public/`: Static assets (e.g., images, fonts).
- `Dockerfile`: For containerizing the app.
- `package.json`: Project metadata, dependencies, and scripts.

---

## How It Works

1. **Templates** are defined as JSON objects describing the layout, fonts, images, and data fields for a PDF.
2. **User Data** is submitted and stored as a "print token" via the `/token/:apikey` endpoint.
3. **PDF Generation** is triggered by requesting `/pdf/:docname/:ptoken`, which combines the template and data, builds the PDF, and streams it to the client.
4. **Authentication** is enforced using API keys and PocketBase user records.

---

## Usage

```bash
npm install
npm run dev
```

- Access the app: [http://localhost:3000](http://localhost:3000)
- Healthcheck: [http://localhost:8080/healthcheck](http://localhost:8080/healthcheck)

---

If you want a more detailed breakdown of any part (e.g., API endpoints, template structure, PDF features), see the source files or open an issue/request!

```
open http://localhost:3000
```
