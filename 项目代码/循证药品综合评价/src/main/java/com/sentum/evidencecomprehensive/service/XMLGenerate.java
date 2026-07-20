package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import lombok.extern.slf4j.Slf4j;
import org.dom4j.Document;
import org.dom4j.DocumentHelper;
import org.dom4j.Element;
import org.dom4j.io.XMLWriter;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Component;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Component
public class XMLGenerate {

    @Autowired
    MongoTemplate mongoTemplate;

    @SuppressWarnings("all")
    public List<File> generateXML(String id) throws IOException {
//        List<JSONObject> literatures = mongoTemplate.find(new Query(Criteria.where("resource_id").is(Long.valueOf(id))), JSONObject.class, "data_" + userUtil.getCurrentUser().getUserId() % 100);
        List<JSONObject> literatures = mongoTemplate.find(new Query(Criteria.where("resource_id").is(Long.valueOf(id))), JSONObject.class, "data_" + 100 % 100);
        Map<String, List<JSONObject>> map = new HashMap<>();
        List<File> files = new ArrayList<>();
        for (JSONObject jsonObject : literatures) {
            if (map.containsKey(jsonObject.getJSONArray("s_type").toString())) {
                map.get(jsonObject.getJSONArray("s_type").toString()).add(jsonObject);
            } else {
                map.put(jsonObject.getJSONArray("s_type").toString(), new ArrayList<>());
                map.get(jsonObject.getJSONArray("s_type").toString()).add(jsonObject);
            }
        }

        Map<String, Integer> sTypeMap = new HashMap<>();
        sTypeMap.put("Meta分析", 3);
        sTypeMap.put("RCT", 4);
        sTypeMap.put("观察性研究", 5);
        sTypeMap.put("经济学研究", 6);
        sTypeMap.put("文献综述", 0);
        sTypeMap.put("临床试验", 7);
        sTypeMap.put("病例系列", 1);

        for (Map.Entry<String, Integer> entryStype : sTypeMap.entrySet()) {
            Document document = DocumentHelper.createDocument();
            Element xml = document.addElement("xml");
            Element records = xml.addElement("records");
            int total = 0;
            for (Map.Entry<String, List<JSONObject>> entry1 : map.entrySet()) {
                List<Integer> sTypeList = JSONArray.parseArray(entry1.getKey()).toJavaList(Integer.class);
                if(!sTypeList.contains(entryStype.getValue())){
                    continue;
                }
//                for (JSONObject jsonObject : entry1.getValue()) {
//                    for (Map.Entry<String, Object> entry : jsonObject.entrySet()) {
//                        if (entry.getValue() != null && StringUtils.isNotEmpty(entry.getValue().toString())) {
//                            String str = entry.getValue().toString();
//                            str = str.replaceAll(";lt.*?;gt;|&amp", "");
//                            str = str.replaceAll("<.*?>", "");
//                            jsonObject.put(entry.getKey(), str);
//                        }
//                    }
//                }
                for (Map<String, Object> m : entry1.getValue()) {
                    total++;
                    Element record = records.addElement("record");
                    Element database = record.addElement("database");
                    Element contributors = record.addElement("contributors");
                    Element authors = contributors.addElement("authors");
                    Element translated_authors = contributors.addElement("translated-authors");

                    //处理作者
                    authors.addElement("author").addText(m.get("author") == null ? "暂无数据" : m.get("author").toString());
                    translated_authors.addElement("author").addText(m.get("translated_author") == null ? "暂无数据" : m.get("translated_author").toString());

                    //翻译作者
                    //Element translatedAuthors = contributors.addElement("translated-authors");
                    //作者地址
                    Element authAddress = contributors.addElement("auth-address");

                    authAddress.addElement("author-address").addText(m.get("author_address") == null ? "暂无数据" : m.get("author_address").toString());

                    //处理标题
                    Element titles = contributors.addElement("titles");
                    titles.addElement("title").addText(m.get("title") == null ? "暂无数据" : m.get("title").toString());

                    //处理期刊信息
                    String magazine_name = m.get("journal") == null ? "暂无数据" : m.get("journal").toString();
//                    titles.addElement("secondary-title").addText(magazine_name);
//                    Element periodical = record.addElement("periodical").addElement("full-title").addElement("style").addText(magazine_name);
//                    Element volume = record.addElement("volume").addText(m.get("volume") == null ? "暂无数据" : m.get("volume").toString());
//                    Element part = record.addElement("num-vols").addText(m.get("part_supplement") == null ? "暂无数据" : m.get("part_supplement").toString());
//                    Element issue = record.addElement("number").addText(m.get("issue") == null ? "暂无数据" : m.get("issue").toString());
//                    Element pages = record.addElement("pages").addText(m.get("pages") == null ? "暂无数据" : m.get("pages").toString());
//                    Element section = record.addElement("section").addText(m.get("start_page") == null ? "暂无数据" : m.get("start_page").toString());
//                    Element errata = titles.addElement("tertiary-title").addText(m.get("errata") == null ? "暂无数据" : m.get("errata").toString());
//                    Element edition = record.addElement("edition").addText(m.get("epub_date") == null ? "暂无数据" : m.get("epub_date").toString());
//                    Element work_type = record.addElement("work-type").addText(m.get("type_of_article") == null ? "暂无数据" : m.get("type_of_article").toString());
//                    Element short_title = titles.addElement("short-title").addText(m.get("short_title") == null ? "暂无数据" : m.get("short_title").toString());
//                    Element alt_title = titles.addElement("alt-title").addText(m.get("alernate_journal") == null ? "暂无数据" : m.get("alernate_journal").toString());
//                    Element isbn = record.addElement("isbn").addText(m.get("issn") == null ? "暂无数据" : m.get("issn").toString());
//                    Element electronic_resource_num = record.addElement("electronic-resource-num").addText(m.get("doi") == null ? "暂无数据" : m.get("doi").toString());
//                    Element orig_pub = record.addElement("orig-pub").addText(m.get("original_publication") == null ? "暂无数据" : m.get("original_publication").toString());
//                    Element reprint_edition = record.addElement("reprint-edition").addText(m.get("reprint_edition") == null ? "暂无数据" : m.get("reprint_edition").toString());
//                    Element reviewed_item = record.addElement("reviewed-item").addText(m.get("reviewed_item") == null ? "暂无数据" : m.get("reprint_edition").toString());
//                    Element custom1 = record.addElement("custom1").addText(m.get("legal_note") == null ? "暂无数据" : m.get("legal_note").toString());
//                    Element custom2 = record.addElement("custom2").addText(m.get("pmcid") == null ? "暂无数据" : m.get("pmcid").toString());
//                    Element custom6 = record.addElement("custom6").addText(m.get("nimsid") == null ? "暂无数据" : m.get("nimsid").toString());
//                    Element custom7 = record.addElement("custom7").addText(m.get("article_number") == null ? "暂无数据" : m.get("article_number").toString());
//                    Element accession_num = record.addElement("accession_num").addText(m.get("accession_number") == null ? "暂无数据" : m.get("accession_number").toString());
//                    Element call_num = record.addElement("accession_num").addText(m.get("call_number") == null ? "暂无数据" : m.get("call_number").toString());
//                    Element label = record.addElement("label").addText(m.get("label") == null ? "暂无数据" : m.get("label").toString());
//                    Element notes = record.addElement("notes").addText(m.get("notes") == null ? "暂无数据" : m.get("notes").toString());
//                    Element research_notes = record.addElement("research-notes").addText(m.get("research_notes") == null ? "暂无数据" : m.get("research_notes").toString());
//                    Element caption = record.addElement("caption").addText(m.get("caption") == null ? "暂无数据" : m.get("caption").toString());
//                    Element access_date = record.addElement("access-date").addText(m.get("access_date") == null ? "暂无数据" : m.get("access_date").toString());
//                    Element translated_title = titles.addElement("translated-title").addText(m.get("translated_title") == null ? "暂无数据" : m.get("translated_title").toString());
//                    Element remote_database_name = record.addElement("remote-database-name").addText(m.get("remote_database_name") == null ? "暂无数据" : m.get("remote_database_name").toString());

                    //关键字
                    String kw = "";
                    if (m.get("keywords") != null) {
                        kw = m.get("keywords").toString().toString();
                    }

                    Element keywords = contributors.addElement("keywords").addElement("keyword").addText(kw);
                    //published_date
                    Element dates = contributors.addElement("dates");
                    dates.addElement("year").addText(m.get("year") == null ? "暂无数据" : m.get("year").toString());
                    dates.addElement("pub-dates").addElement("date").addText(m.get("date") == null ? "暂无数据" : m.get("date").toString());

                    //处理摘要
                    String strSummary = "";
                    if (m.get("summary") != null) {
                        strSummary = m.get("summary").toString();
                    }
                    Element summary = contributors.addElement("abstract");
                    summary.addText(strSummary);
                    String strURL = "";
                    if (m.get("url") != null) {
                        strURL = m.get("url").toString();
                    }
                    Element URL = contributors.addElement("URL");
                    URL.addText(strURL);
                    Element urls = contributors.addElement("urls").addElement("related-urls").addElement("url").addText("https://sentumhealth.com/");
                    Element provider = contributors.addElement("remote-database-provider").addText("灵犀量子");
                }
            }

            String path = System.getProperty("java.io.tmpdir") + Constants.PAD_LEFT_SLASH + id;
            if (!new File(path).exists()) {
                if (!new File(path).mkdirs()) {
                    log.error("创建下载目录失败");
                }
            }
            if(total > 0) {
                String fileName = path + Constants.PAD_LEFT_SLASH + entryStype.getKey() + "(" + total + ")" + ".xml";
                XMLWriter writer = null;
                try (OutputStream out = new FileOutputStream(fileName)) {
                    writer = new XMLWriter(new OutputStreamWriter(out, StandardCharsets.UTF_8));
                    writer.write(document);
                    writer.close();
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
                File file = new File(fileName);
                if (file.exists()) {
                    files.add(file);
                }
            }
        }
        return files;
    }
}
