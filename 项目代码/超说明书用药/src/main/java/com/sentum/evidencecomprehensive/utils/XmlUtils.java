package com.sentum.evidencecomprehensive.utils;

import com.sentum.evidencecomprehensive.pojo.bo.mongo.MongoLiterature;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang3.StringUtils;
import org.dom4j.Element;

import java.util.List;

/**
 * 构建xml文件的工具类
 * @author zgm
 */
public class XmlUtils {
    /**
     * dom4j生成文献引用的xml
     * @param records dom4j的Element对象
     * @param mongoLiterature 单个文献的数据
     */
    public static void batchExportXml(Element records, MongoLiterature mongoLiterature){
        //单个节点
        Element record = records.addElement("record");
        //database
        record.addElement("database").addText("EviMed");
        //contributors
        Element contributors = record.addElement("contributors");
        //contributors内部
        //authors
        Element authors = contributors.addElement("authors");
        List<String> author = mongoLiterature.getAuthor();
        if (CollectionUtils.isNotEmpty(author)){
            for (String s : author) {
                authors.addElement("author").addText(s);
            }
        }
        //translated-authors
        Element translatedAuthors = contributors.addElement("translated-authors");
        translatedAuthors.addElement("author").addText("暂无数据");
        //auth-address
        Element authAddresses = contributors.addElement("auth-addresses");
        List<String> authorFacility = mongoLiterature.getAuthorFacility();
        if (CollectionUtils.isNotEmpty(authorFacility)){
            for (String s : authorFacility) {
                authAddresses.addElement("auth-address").addText(s);
            }
        }
        //titles
        Element titles = contributors.addElement("titles");
        String title = mongoLiterature.getTitle();
        if (StringUtils.isNotBlank(title)){
            titles.addElement("title").addText(title);
        }
        String journal = mongoLiterature.getJournal() != null ? mongoLiterature.getJournal() : "暂无数据";
        titles.addElement("secondary-title").addText(journal);
        titles.addElement("tertiary-title").addText("暂无数据");
        titles.addElement("short-title").addText("暂无数据");
        titles.addElement("alt-title").addText("暂无数据");
        titles.addElement("translated-title").addText("暂无数据");
        //titles
        Element periodical = contributors.addElement("periodical");
        periodical.addElement("full-title").addText(journal);
        //keywords
        Element keywords = contributors.addElement("keywords");
        List<String> allKeyword = mongoLiterature.getAllKeyword();
        if (CollectionUtils.isNotEmpty(allKeyword)){
            for (String s : allKeyword) {
                keywords.addElement("keyword").addText(s);
            }
        }
        //dates
        Element dates = contributors.addElement("dates");
        String year = mongoLiterature.getYear() != null ? mongoLiterature.getYear() : "暂无数据";
        dates.addElement("year").addText(year);
        dates.addElement("pub-dates").addElement("data").addText("暂无数据");
        //abstract
        Element abstractElement = contributors.addElement("abstract");
        String summary = mongoLiterature.getSummary() != null ? mongoLiterature.getSummary() : "暂无数据";
        abstractElement.addText(summary);
        //URL
        contributors.addElement("URL");
        //urls
        Element urls = contributors.addElement("urls");
        Element relatedUrls = urls.addElement("related-urls");
        relatedUrls.addElement("url").addText("https://www.evimed.com");
        //remote-database-provider
        contributors.addElement("remote-database-provider").addText("灵犀量子");
        //periodical
        //Element periodical = record.addElement("periodical");
        //periodical.addElement("full-title").addElement("style").addText(journal);
        //volume
        record.addElement("volume").addText(mongoLiterature.getVolume() != null ? mongoLiterature.getVolume().get(0) : "暂无数据");
        //num-vols
        record.addElement("num-vols").addText("暂无数据");
        //number
        record.addElement("number").addText("暂无数据");
        //pages
        if (StringUtils.isNotEmpty(mongoLiterature.getPages())) {
            record.addElement("pages").addText(mongoLiterature.getPages());
        }
        //section
        record.addElement("section").addText("暂无数据");
        //edition
        record.addElement("edition").addText("暂无数据");
        //work-type
        record.addElement("work-type").addText("暂无数据");
        //isbn
        record.addElement("isbn").addText("暂无数据");
        //electronic-resource-num
        record.addElement("electronic-resource-num").addText("暂无数据");
        //orig-pub
        record.addElement("orig-pub").addText("暂无数据");
        //reprint-edition
        record.addElement("reprint-edition").addText("暂无数据");
        //reviewed-item
        record.addElement("reviewed-item").addText("暂无数据");
        //custom1
        record.addElement("custom1").addText("暂无数据");
        //custom2
        record.addElement("custom2").addText("暂无数据");
        //custom6
        record.addElement("custom6").addText("暂无数据");
        //custom7
        record.addElement("custom7").addText("暂无数据");
        //accession_num
        record.addElement("accession_num").addText("暂无数据");
        //label
        record.addElement("label").addText("暂无数据");
        //notes
        record.addElement("notes").addText("暂无数据");
        //research-notes
        record.addElement("research-notes").addText("暂无数据");
        //caption
        record.addElement("caption").addText("暂无数据");
        //access-date
        record.addElement("access-date").addText("暂无数据");
        //remote-database-name
        record.addElement("remote-database-name").addText("暂无数据");
    }
}
