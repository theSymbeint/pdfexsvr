import PocketBase from "pocketbase"

const dburl = process.env.DBURL || 'https://pb-pdfex-dev.eemerg.dev/'

const pbClient = new PocketBase(dburl)

export default pbClient