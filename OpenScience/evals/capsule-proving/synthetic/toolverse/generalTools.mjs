/**
 * The general graph's closed list of generic tools (Toucan's schemas were not pinned when this was written, so the general
 * graph is built from this list; swap in a Toucan subset by adding another list here). Ten servers, 33 tools.
 * @module capsule-proving/synthetic/toolverse/generalTools
 */
import { tool } from './toolSpec.mjs';

export const GENERAL_TOOLS = [
  // calendar
  tool('get_current_date', 'calendar', 'Today\'s date.', [], ['today:date']),
  tool('add_days', 'calendar', 'Add a number of days to a date.', ['date:date', 'days:days'], ['result:date']),
  tool('create_event', 'calendar', 'Create a calendar event.', ['title:eventTitle', 'date:date'], ['eventId:eventId']),
  tool('get_event', 'calendar', 'Read one calendar event.', ['eventId:eventId'], ['title:eventTitle', 'date:date', 'organizerEmail:email']),
  tool('list_events', 'calendar', 'List the events of a date.', ['date:date'], ['firstEventId:eventId', 'eventCount:count']),
  // contacts and mail
  tool('find_contact', 'contacts', 'Find a contact by name.', ['name:contactName'], ['email:email', 'phone:phone']),
  tool('send_email', 'mail', 'Send an e-mail.', ['to:email', 'body:text'], ['messageId:messageId']),
  tool('get_message', 'mail', 'Read one sent message.', ['messageId:messageId'], ['body:text', 'recipient:email']),
  // units
  tool('convert_length', 'units', 'Convert a length.', ['value:quantity', 'from:lengthUnit', 'to:lengthUnit'], ['converted:quantity']),
  tool('convert_mass', 'units', 'Convert a mass.', ['value:quantity', 'from:massUnit', 'to:massUnit'], ['converted:quantity']),
  tool('convert_temperature', 'units', 'Convert Celsius to Fahrenheit.', ['celsius:temperature'], ['fahrenheit:temperature']),
  // currency
  tool('get_exchange_rate', 'currency', 'The exchange rate between two currencies.', ['from:currency', 'to:currency'], ['rate:rate']),
  tool('convert_currency', 'currency', 'Convert an amount using a rate.', ['amount:amount', 'rate:rate'], ['converted:amount']),
  tool('get_expense_report', 'expenses', 'An expense report for a month.', ['month:month'], ['reportId:reportId', 'total:amount', 'currency:currency']),
  tool('submit_reimbursement', 'expenses', 'Submit a reimbursement for a report.', ['reportId:reportId', 'currency:currency'], ['claimId:reportId']),
  // weather
  tool('geocode_city', 'weather', 'Coordinates of a city.', ['city:city'], ['lat:lat', 'lon:lon']),
  tool('get_forecast', 'weather', 'The forecast at coordinates.', ['lat:lat', 'lon:lon'], ['temperature:temperature', 'condition:condition']),
  tool('get_air_quality', 'weather', 'Air-quality index at coordinates.', ['lat:lat', 'lon:lon'], ['aqi:count']),
  // files
  tool('list_directory', 'files', 'List a folder.', ['dir:dirPath'], ['firstFile:filePath', 'fileCount:count']),
  tool('read_file', 'files', 'Read a text file.', ['path:filePath'], ['content:text', 'lineCount:count']),
  tool('write_file', 'files', 'Write a text file.', ['path:filePath', 'content:text'], ['writtenPath:filePath']),
  tool('copy_file', 'files', 'Copy a file into a folder.', ['path:filePath', 'dir:dirPath'], ['newPath:filePath']),
  tool('file_stat', 'files', 'Size and line count of a file.', ['path:filePath'], ['size:count']),
  // search and web
  tool('search_web', 'search', 'Search the web.', ['query:searchQuery'], ['topUrl:url']),
  tool('fetch_url', 'search', 'Fetch a web page as text.', ['url:url'], ['content:text', 'title:text']),
  tool('translate_text', 'search', 'Translate a text.', ['text:text', 'target:language'], ['translated:text']),
  tool('summarize_text', 'search', 'Summarize a text.', ['text:text'], ['summary:text']),
  // tables
  tool('load_table', 'tables', 'Load a CSV into a table.', ['path:filePath'], ['tableId:tableId', 'rowCount:count']),
  tool('filter_table', 'tables', 'Filter rows of a table.', ['tableId:tableId', 'column:columnName', 'value:filterValue'], ['filteredTableId:tableId', 'rowCount:count']),
  tool('sum_column', 'tables', 'Sum a numeric column.', ['tableId:tableId', 'column:columnName'], ['sum:amount']),
  tool('sort_table', 'tables', 'Sort a table by a column.', ['tableId:tableId', 'column:columnName'], ['sortedTableId:tableId']),
  tool('export_table', 'tables', 'Export a table to a CSV file.', ['tableId:tableId', 'path:filePath'], ['exportedPath:filePath']),
  tool('describe_table', 'tables', 'Describe the columns of a table.', ['tableId:tableId'], ['rowCount:count', 'firstColumn:columnName']),
];
