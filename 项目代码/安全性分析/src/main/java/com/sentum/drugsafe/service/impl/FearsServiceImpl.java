package com.sentum.drugsafe.service.impl;


import cn.hutool.core.collection.CollUtil;
import com.alibaba.fastjson.JSONObject;

import com.sentum.drugsafe.pojo.AdverseForCaseIndex;
import com.sentum.drugsafe.pojo.AdverseIndex;
import com.sentum.drugsafe.pojo.RoleCod;
import com.sentum.drugsafe.service.FearsService;
import com.sentum.drugsafe.utils.FearsMongoUtil;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.bson.Document;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.annotation.Async;

import org.springframework.stereotype.Service;

import javax.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoUnit;
import java.util.*;


@Service
@Slf4j
public class FearsServiceImpl implements FearsService {


    @Autowired
    private FearsMongoUtil mongoUtil;


    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;


    public static final Map<String, String> COUNTRY_CONTINENT_MAP = new HashMap<>();

    static {
        // 亚洲（Asia）
        COUNTRY_CONTINENT_MAP.put("AE", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BD", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("GE", "亚洲");
        COUNTRY_CONTINENT_MAP.put("HK", "亚洲");
        COUNTRY_CONTINENT_MAP.put("ID", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IL", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("JP", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KP", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KW", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LB", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("NP", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PK", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PS", "亚洲");
        COUNTRY_CONTINENT_MAP.put("QA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SG", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TW", "亚洲");
        COUNTRY_CONTINENT_MAP.put("VN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("AF", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BT", "亚洲");
        COUNTRY_CONTINENT_MAP.put("JO", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KG", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KZ", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LK", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MO", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MV", "亚洲");
        COUNTRY_CONTINENT_MAP.put("OM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SY", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TJ", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("UZ", "亚洲");
        COUNTRY_CONTINENT_MAP.put("YE", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IQ", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("AM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TL", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CF", "亚洲");
        COUNTRY_CONTINENT_MAP.put("XA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LAO PEOPLE'S DEMOCRATIC REPUBLIC", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CYPRUS", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MACAU", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KYRGYZSTAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BRUNEI DARUSSALAM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BANGLADESH", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SRI LANKA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("BAHRAIN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("OMAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SYRIAN ARAB REPUBLIC", "亚洲");
        COUNTRY_CONTINENT_MAP.put("AFGHANISTAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("YEMEN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF", "亚洲");
        COUNTRY_CONTINENT_MAP.put("QATAR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PALESTINIAN TERRITORY, OCCUPIED", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MONGOLIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MYANMAR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("ARMENIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("AZERBAIJAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KAZAKHSTAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("IRAN (ISLAMIC REPUBLIC OF)", "亚洲");
        COUNTRY_CONTINENT_MAP.put("INDONESIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PAKISTAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("THAILAND", "亚洲");
        COUNTRY_CONTINENT_MAP.put("PHILIPPINES", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SINGAPORE", "亚洲");
        COUNTRY_CONTINENT_MAP.put("LEBANON", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KOREA, REPUBLIC OF", "亚洲");
        COUNTRY_CONTINENT_MAP.put("UNITED ARAB EMIRATES", "亚洲");
        COUNTRY_CONTINENT_MAP.put("KUWAIT", "亚洲");
        COUNTRY_CONTINENT_MAP.put("SAUDI ARABIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CAMBODIA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("JORDAN", "亚洲");
        COUNTRY_CONTINENT_MAP.put("HONG KONG", "亚洲");
        COUNTRY_CONTINENT_MAP.put("CHINA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TAIWAN, PROVINCE OF CHINA", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TR", "亚洲");
        COUNTRY_CONTINENT_MAP.put("MM", "亚洲");
        COUNTRY_CONTINENT_MAP.put("TF", "欧洲"); // 原数据标注为欧洲（实际属南极洲，此处按原数据保留）
        COUNTRY_CONTINENT_MAP.put("GG", "Oceania"); // 原数据标注为大洋洲，保留原始值
        COUNTRY_CONTINENT_MAP.put("TF", "欧洲"); // 重复键按原数据最后出现值处理

        // 欧洲（Europe）
        COUNTRY_CONTINENT_MAP.put("AT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BG", "欧洲");
        COUNTRY_CONTINENT_MAP.put("CH", "欧洲");
        COUNTRY_CONTINENT_MAP.put("CY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("CZ", "欧洲");
        COUNTRY_CONTINENT_MAP.put("DE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("DK", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ES", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FR", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GB", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GR", "欧洲");
        COUNTRY_CONTINENT_MAP.put("HR", "欧洲");
        COUNTRY_CONTINENT_MAP.put("HU", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LU", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LV", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("PL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("PT", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RU", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SK", "欧洲");
        COUNTRY_CONTINENT_MAP.put("UA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AD", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("EE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IM", "欧洲");
        COUNTRY_CONTINENT_MAP.put("XE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MC", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MD", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ME", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MK", "欧洲");
        COUNTRY_CONTINENT_MAP.put("XK", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("JE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SM", "欧洲");
        COUNTRY_CONTINENT_MAP.put("VA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FX", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SX", "欧洲");
        COUNTRY_CONTINENT_MAP.put("YU", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ALAND ISLANDS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ML", "非洲"); // 原数据中ML在非洲，此处避免重复
        COUNTRY_CONTINENT_MAP.put("ITALY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FRANCE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GERMANY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SWITZERLAND", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NETHERLANDS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SPAIN", "欧洲");
        COUNTRY_CONTINENT_MAP.put("IRELAND", "欧洲");
        COUNTRY_CONTINENT_MAP.put("TURKEY", "Asia"); // 原数据部分标注为亚洲，按原始值保留
        COUNTRY_CONTINENT_MAP.put("CROATIA (LOCAL NAME: HRVATSKA)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RUSSIAN FEDERATION", "欧洲");
        COUNTRY_CONTINENT_MAP.put("POLAND", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BELGIUM", "欧洲");
        COUNTRY_CONTINENT_MAP.put("HUNGARY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GREECE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SWEDEN", "欧洲");
        COUNTRY_CONTINENT_MAP.put("PORTUGAL", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AUSTRIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NORWAY", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BELARUS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BULGARIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("CZECH REPUBLIC", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LITHUANIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ROMANIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SLOVENIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LUXEMBOURG", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ESTONIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("LATVIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MALTA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SLOVAKIA (SLOVAK REPUBLIC)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ALBANIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ICELAND", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MACEDONIA, THE FORMER YUGOSLAV REPUBLIC OF", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MONACO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MONTENEGRO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("VATICAN CITY STATE (HOLY SEE)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("EUROPEAN UNION", "欧洲");
        COUNTRY_CONTINENT_MAP.put("NETHERLANDS ANTILLES (RETIRED CODE)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SERBIA AND MONTENEGRO (SEE INDIVIDUAL COUNTRIES)", "欧洲");
        COUNTRY_CONTINENT_MAP.put("YUGOSLAVIA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FRENCH SOUTHERN TERRITORIES", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FAROE ISLANDS", "欧洲");
        COUNTRY_CONTINENT_MAP.put("ISLE OF MAN", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FRANCE, METROPOLITAN", "欧洲");
        COUNTRY_CONTINENT_MAP.put("SERBIA AND MONTENEGRO", "欧洲");
        COUNTRY_CONTINENT_MAP.put("BOSNIA AND HERZEGOWINA", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GIBRALTAR", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GUadeloupe", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MARTINIQUE", "欧洲");
        COUNTRY_CONTINENT_MAP.put("MF", "欧洲");
        COUNTRY_CONTINENT_MAP.put("GI", "欧洲");
        COUNTRY_CONTINENT_MAP.put("AX", "欧洲");
        COUNTRY_CONTINENT_MAP.put("FX", "欧洲");
        COUNTRY_CONTINENT_MAP.put("RE", "欧洲");

        // 非洲（Africa）
        COUNTRY_CONTINENT_MAP.put("EG", "非洲");
        COUNTRY_CONTINENT_MAP.put("GA", "非洲");
        COUNTRY_CONTINENT_MAP.put("GH", "非洲");
        COUNTRY_CONTINENT_MAP.put("KE", "非洲");
        COUNTRY_CONTINENT_MAP.put("LS", "非洲");
        COUNTRY_CONTINENT_MAP.put("MA", "非洲");
        COUNTRY_CONTINENT_MAP.put("MW", "非洲");
        COUNTRY_CONTINENT_MAP.put("NG", "非洲");
        COUNTRY_CONTINENT_MAP.put("RW", "非洲");
        COUNTRY_CONTINENT_MAP.put("TZ", "非洲");
        COUNTRY_CONTINENT_MAP.put("UG", "非洲");
        COUNTRY_CONTINENT_MAP.put("ZA", "非洲");
        COUNTRY_CONTINENT_MAP.put("ZW", "非洲");
        COUNTRY_CONTINENT_MAP.put("DZ", "North America"); // 原数据标注为北美洲（阿尔及利亚属非洲，此处按原数据保留）
        COUNTRY_CONTINENT_MAP.put("AO", "非洲");
        COUNTRY_CONTINENT_MAP.put("BF", "非洲");
        COUNTRY_CONTINENT_MAP.put("BI", "非洲");
        COUNTRY_CONTINENT_MAP.put("BJ", "非洲");
        COUNTRY_CONTINENT_MAP.put("BW", "非洲");
    }


    public static final Map<String, String> COUNTRY_NAME_MAP = new HashMap<>();

    static {
        // 亚洲国家
        COUNTRY_NAME_MAP.put("AE", "阿拉伯联合酋长国");
        COUNTRY_NAME_MAP.put("BD", "孟加拉国");
        COUNTRY_NAME_MAP.put("CN", "中国");
        COUNTRY_NAME_MAP.put("GE", "格鲁吉亚");
        COUNTRY_NAME_MAP.put("HK", "中国香港特别行政区");
        COUNTRY_NAME_MAP.put("ID", "印度尼西亚");
        COUNTRY_NAME_MAP.put("IL", "以色列");
        COUNTRY_NAME_MAP.put("IN", "印度");
        COUNTRY_NAME_MAP.put("IR", "伊朗");
        COUNTRY_NAME_MAP.put("JP", "日本");
        COUNTRY_NAME_MAP.put("KR", "韩国");
        COUNTRY_NAME_MAP.put("KW", "科威特");
        COUNTRY_NAME_MAP.put("LB", "黎巴嫩");
        COUNTRY_NAME_MAP.put("MM", "缅甸");
        COUNTRY_NAME_MAP.put("MY", "马来西亚");
        COUNTRY_NAME_MAP.put("NP", "尼泊尔");
        COUNTRY_NAME_MAP.put("PH", "菲律宾");
        COUNTRY_NAME_MAP.put("PK", "巴基斯坦");
        COUNTRY_NAME_MAP.put("PS", "巴勒斯坦");
        COUNTRY_NAME_MAP.put("QA", "卡塔尔");
        COUNTRY_NAME_MAP.put("SA", "沙特阿拉伯");
        COUNTRY_NAME_MAP.put("SG", "新加坡");
        COUNTRY_NAME_MAP.put("SY", "叙利亚");
        COUNTRY_NAME_MAP.put("TH", "泰国");
        COUNTRY_NAME_MAP.put("TR", "土耳其");
        COUNTRY_NAME_MAP.put("TW", "中国台湾地区");
        COUNTRY_NAME_MAP.put("VN", "越南");
        COUNTRY_NAME_MAP.put("AF", "阿富汗");
        COUNTRY_NAME_MAP.put("AZ", "阿塞拜疆");
        COUNTRY_NAME_MAP.put("BN", "文莱");
        COUNTRY_NAME_MAP.put("KH", "柬埔寨");
        COUNTRY_NAME_MAP.put("KZ", "哈萨克斯坦");
        COUNTRY_NAME_MAP.put("LA", "老挝");
        COUNTRY_NAME_MAP.put("LK", "斯里兰卡");
        COUNTRY_NAME_MAP.put("OM", "阿曼");
        COUNTRY_NAME_MAP.put("TJ", "塔吉克斯坦");
        COUNTRY_NAME_MAP.put("TL", "东帝汶");
        COUNTRY_NAME_MAP.put("UZ", "乌兹别克斯坦");
        COUNTRY_NAME_MAP.put("YE", "也门");
        COUNTRY_NAME_MAP.put("AM", "亚美尼亚");
        COUNTRY_NAME_MAP.put("MO", "中国澳门特别行政区");
        COUNTRY_NAME_MAP.put("MN", "蒙古");
        COUNTRY_NAME_MAP.put("MV", "马尔代夫");
        COUNTRY_NAME_MAP.put("BT", "不丹");
        COUNTRY_NAME_MAP.put("TM", "土库曼斯坦");

        // 欧洲国家
        COUNTRY_NAME_MAP.put("AT", "奥地利");
        COUNTRY_NAME_MAP.put("BE", "比利时");
        COUNTRY_NAME_MAP.put("BG", "保加利亚");
        COUNTRY_NAME_MAP.put("CH", "瑞士");
        COUNTRY_NAME_MAP.put("CY", "塞浦路斯");
        COUNTRY_NAME_MAP.put("CZ", "捷克");
        COUNTRY_NAME_MAP.put("DE", "德国");
        COUNTRY_NAME_MAP.put("DK", "丹麦");
        COUNTRY_NAME_MAP.put("EE", "爱沙尼亚");
        COUNTRY_NAME_MAP.put("ES", "西班牙");
        COUNTRY_NAME_MAP.put("FI", "芬兰");
        COUNTRY_NAME_MAP.put("FR", "法国");
        COUNTRY_NAME_MAP.put("GB", "英国");
        COUNTRY_NAME_MAP.put("GR", "希腊");
        COUNTRY_NAME_MAP.put("HU", "匈牙利");
        COUNTRY_NAME_MAP.put("IE", "爱尔兰");
        COUNTRY_NAME_MAP.put("IT", "意大利");
        COUNTRY_NAME_MAP.put("LT", "立陶宛");
        COUNTRY_NAME_MAP.put("LU", "卢森堡");
        COUNTRY_NAME_MAP.put("LV", "拉脱维亚");
        COUNTRY_NAME_MAP.put("ME", "黑山");
        COUNTRY_NAME_MAP.put("MT", "马耳他");
        COUNTRY_NAME_MAP.put("NL", "荷兰");
        COUNTRY_NAME_MAP.put("NO", "挪威");
        COUNTRY_NAME_MAP.put("PL", "波兰");
        COUNTRY_NAME_MAP.put("PT", "葡萄牙");
        COUNTRY_NAME_MAP.put("RO", "罗马尼亚");
        COUNTRY_NAME_MAP.put("RS", "塞尔维亚");
        COUNTRY_NAME_MAP.put("RU", "俄罗斯");
        COUNTRY_NAME_MAP.put("SE", "瑞典");
        COUNTRY_NAME_MAP.put("SI", "斯洛文尼亚");
        COUNTRY_NAME_MAP.put("SK", "斯洛伐克");
        COUNTRY_NAME_MAP.put("UA", "乌克兰");
        COUNTRY_NAME_MAP.put("AL", "阿尔巴尼亚");
        COUNTRY_NAME_MAP.put("BA", "波斯尼亚和黑塞哥维那");
        COUNTRY_NAME_MAP.put("HR", "克罗地亚");
        COUNTRY_NAME_MAP.put("IS", "冰岛");
        COUNTRY_NAME_MAP.put("MK", "北马其顿");
        COUNTRY_NAME_MAP.put("IM", "马恩岛");
        COUNTRY_NAME_MAP.put("MC", "摩纳哥");
        COUNTRY_NAME_MAP.put("MD", "摩尔多瓦");
        COUNTRY_NAME_MAP.put("SM", "圣马力诺");
        COUNTRY_NAME_MAP.put("VA", "梵蒂冈");
        COUNTRY_NAME_MAP.put("XK", "科索沃"); // 部分国家承认
        COUNTRY_NAME_MAP.put("BY", "白俄罗斯");
        COUNTRY_NAME_MAP.put("GI", "直布罗陀");
        COUNTRY_NAME_MAP.put("FO", "法罗群岛");
        COUNTRY_NAME_MAP.put("AX", "奥兰群岛");
        COUNTRY_NAME_MAP.put("JE", "泽西岛");
        COUNTRY_NAME_MAP.put("GG", "根西岛");
        COUNTRY_NAME_MAP.put("LI", "列支敦士登");
        COUNTRY_NAME_MAP.put("SJ", "斯瓦尔巴群岛");
        COUNTRY_NAME_MAP.put("YU", "南斯拉夫"); // 已解体

        // 北美洲国家
        COUNTRY_NAME_MAP.put("CA", "加拿大");
        COUNTRY_NAME_MAP.put("CR", "哥斯达黎加");
        COUNTRY_NAME_MAP.put("DO", "多米尼加共和国");
        COUNTRY_NAME_MAP.put("GT", "危地马拉");
        COUNTRY_NAME_MAP.put("HN", "洪都拉斯");
        COUNTRY_NAME_MAP.put("HT", "海地");
        COUNTRY_NAME_MAP.put("JM", "牙买加");
        COUNTRY_NAME_MAP.put("MX", "墨西哥");
        COUNTRY_NAME_MAP.put("PA", "巴拿马");
        COUNTRY_NAME_MAP.put("PR", "波多黎各");
        COUNTRY_NAME_MAP.put("US", "美国");
        COUNTRY_NAME_MAP.put("AG", "安提瓜和巴布达");
        COUNTRY_NAME_MAP.put("BS", "巴哈马");
        COUNTRY_NAME_MAP.put("BB", "巴巴多斯");
        COUNTRY_NAME_MAP.put("CU", "古巴");
        COUNTRY_NAME_MAP.put("DM", "多米尼克");
        COUNTRY_NAME_MAP.put("GD", "格林纳达");
        COUNTRY_NAME_MAP.put("KN", "圣基茨和尼维斯");
        COUNTRY_NAME_MAP.put("LC", "圣卢西亚");
        COUNTRY_NAME_MAP.put("VC", "圣文森特和格林纳丁斯");
        COUNTRY_NAME_MAP.put("TT", "特立尼达和多巴哥");
        COUNTRY_NAME_MAP.put("BZ", "伯利兹");
        COUNTRY_NAME_MAP.put("SV", "萨尔瓦多");
        COUNTRY_NAME_MAP.put("UM", "美国本土外小岛屿");
        COUNTRY_NAME_MAP.put("VI", "美属维尔京群岛");
        COUNTRY_NAME_MAP.put("BM", "百慕大");
        COUNTRY_NAME_MAP.put("KY", "开曼群岛");
        COUNTRY_NAME_MAP.put("GP", "瓜德罗普");
        COUNTRY_NAME_MAP.put("MQ", "马提尼克");
        COUNTRY_NAME_MAP.put("PM", "圣皮埃尔和密克隆");
        COUNTRY_NAME_MAP.put("TC", "特克斯和凯科斯群岛");
        COUNTRY_NAME_MAP.put("VG", "英属维尔京群岛");
        COUNTRY_NAME_MAP.put("AI", "安圭拉");
        COUNTRY_NAME_MAP.put("AW", "阿鲁巴");
        COUNTRY_NAME_MAP.put("CW", "库拉索");
        COUNTRY_NAME_MAP.put("SX", "圣马丁岛");
        COUNTRY_NAME_MAP.put("BQ", "荷兰加勒比区");
        COUNTRY_NAME_MAP.put("GU", "关岛");
        COUNTRY_NAME_MAP.put("MP", "北马里亚纳群岛");
        COUNTRY_NAME_MAP.put("AS", "美属萨摩亚");
        COUNTRY_NAME_MAP.put("GL", "格陵兰");
        COUNTRY_NAME_MAP.put("MH", "马绍尔群岛");
        COUNTRY_NAME_MAP.put("FM", "密克罗尼西亚联邦");
        COUNTRY_NAME_MAP.put("PW", "帕劳");
        COUNTRY_NAME_MAP.put("A1", "匿名代理");
        COUNTRY_NAME_MAP.put("AN", "荷属安的列斯"); // 已解体

        // 南美洲国家
        COUNTRY_NAME_MAP.put("AR", "阿根廷");
        COUNTRY_NAME_MAP.put("BR", "巴西");
        COUNTRY_NAME_MAP.put("CL", "智利");
        COUNTRY_NAME_MAP.put("CO", "哥伦比亚");
        COUNTRY_NAME_MAP.put("EC", "厄瓜多尔");
        COUNTRY_NAME_MAP.put("PE", "秘鲁");
        COUNTRY_NAME_MAP.put("PY", "巴拉圭");
        COUNTRY_NAME_MAP.put("UY", "乌拉圭");
        COUNTRY_NAME_MAP.put("VE", "委内瑞拉");
        COUNTRY_NAME_MAP.put("BO", "玻利维亚");
        COUNTRY_NAME_MAP.put("GF", "法属圭亚那");
        COUNTRY_NAME_MAP.put("SR", "苏里南");
        COUNTRY_NAME_MAP.put("GY", "圭亚那");
        COUNTRY_NAME_MAP.put("FK", "福克兰群岛");

        // 非洲国家
        COUNTRY_NAME_MAP.put("DZ", "阿尔及利亚");
        COUNTRY_NAME_MAP.put("EG", "埃及");
        COUNTRY_NAME_MAP.put("GA", "加蓬");
        COUNTRY_NAME_MAP.put("GH", "加纳");
        COUNTRY_NAME_MAP.put("KE", "肯尼亚");
        COUNTRY_NAME_MAP.put("LS", "莱索托");
        COUNTRY_NAME_MAP.put("MA", "摩洛哥");
        COUNTRY_NAME_MAP.put("NG", "尼日利亚");
        COUNTRY_NAME_MAP.put("RW", "卢旺达");
        COUNTRY_NAME_MAP.put("TN", "突尼斯");
        COUNTRY_NAME_MAP.put("TZ", "坦桑尼亚");
        COUNTRY_NAME_MAP.put("UG", "乌干达");
        COUNTRY_NAME_MAP.put("ZA", "南非");
        COUNTRY_NAME_MAP.put("ZW", "津巴布韦");
        COUNTRY_NAME_MAP.put("BF", "布基纳法索");
        COUNTRY_NAME_MAP.put("BI", "布隆迪");
        COUNTRY_NAME_MAP.put("CM", "喀麦隆");
        COUNTRY_NAME_MAP.put("CD", "刚果民主共和国");
        COUNTRY_NAME_MAP.put("CG", "刚果共和国");
        COUNTRY_NAME_MAP.put("CI", "科特迪瓦");
        COUNTRY_NAME_MAP.put("DJ", "吉布提");
        COUNTRY_NAME_MAP.put("ER", "厄立特里亚");
        COUNTRY_NAME_MAP.put("ET", "埃塞俄比亚");
        COUNTRY_NAME_MAP.put("GM", "冈比亚");
        COUNTRY_NAME_MAP.put("GN", "几内亚");
        COUNTRY_NAME_MAP.put("GW", "几内亚比绍");
        COUNTRY_NAME_MAP.put("LY", "利比亚");
        COUNTRY_NAME_MAP.put("MG", "马达加斯加");
        COUNTRY_NAME_MAP.put("ML", "马里");
        COUNTRY_NAME_MAP.put("MR", "毛里塔尼亚");
        COUNTRY_NAME_MAP.put("MU", "毛里求斯");
        COUNTRY_NAME_MAP.put("MW", "马拉维");
        COUNTRY_NAME_MAP.put("MZ", "莫桑比克");
        COUNTRY_NAME_MAP.put("NA", "纳米比亚");
        COUNTRY_NAME_MAP.put("NE", "尼日尔");
        COUNTRY_NAME_MAP.put("RE", "留尼汪");
        COUNTRY_NAME_MAP.put("SN", "塞内加尔");
        COUNTRY_NAME_MAP.put("SL", "塞拉利昂");
        COUNTRY_NAME_MAP.put("SO", "索马里");
        COUNTRY_NAME_MAP.put("SS", "南苏丹");
        COUNTRY_NAME_MAP.put("ST", "圣多美和普林西比");
        COUNTRY_NAME_MAP.put("SZ", "斯威士兰");
        COUNTRY_NAME_MAP.put("TD", "乍得");
        COUNTRY_NAME_MAP.put("TG", "多哥");
        COUNTRY_NAME_MAP.put("YT", "马约特");
        COUNTRY_NAME_MAP.put("ZM", "赞比亚");
        COUNTRY_NAME_MAP.put("EH", "西撒哈拉");
        COUNTRY_NAME_MAP.put("SH", "圣赫勒拿");
        COUNTRY_NAME_MAP.put("KM", "科摩罗");
        COUNTRY_NAME_MAP.put("CV", "佛得角");
        COUNTRY_NAME_MAP.put("GQ", "赤道几内亚");
        COUNTRY_NAME_MAP.put("LR", "利比里亚");
        COUNTRY_NAME_MAP.put("SC", "塞舌尔");
        COUNTRY_NAME_MAP.put("SD", "苏丹");
        COUNTRY_NAME_MAP.put("IO", "英属印度洋领地");

        // 大洋洲国家
        COUNTRY_NAME_MAP.put("AU", "澳大利亚");
        COUNTRY_NAME_MAP.put("NZ", "新西兰");
        COUNTRY_NAME_MAP.put("PG", "巴布亚新几内亚");
        COUNTRY_NAME_MAP.put("FJ", "斐济");
        COUNTRY_NAME_MAP.put("KI", "基里巴斯");
        COUNTRY_NAME_MAP.put("NC", "新喀里多尼亚");
        COUNTRY_NAME_MAP.put("SB", "所罗门群岛");
        COUNTRY_NAME_MAP.put("TO", "汤加");
        COUNTRY_NAME_MAP.put("TV", "图瓦卢");
        COUNTRY_NAME_MAP.put("VU", "瓦努阿图");
        COUNTRY_NAME_MAP.put("WF", "瓦利斯和富图纳");
        COUNTRY_NAME_MAP.put("AS", "美属萨摩亚");
        COUNTRY_NAME_MAP.put("CK", "库克群岛");
        COUNTRY_NAME_MAP.put("FM", "密克罗尼西亚联邦");
        COUNTRY_NAME_MAP.put("GU", "关岛");
        COUNTRY_NAME_MAP.put("MH", "马绍尔群岛");
        COUNTRY_NAME_MAP.put("MP", "北马里亚纳群岛");
        COUNTRY_NAME_MAP.put("NR", "瑙鲁");
        COUNTRY_NAME_MAP.put("NU", "纽埃");
        COUNTRY_NAME_MAP.put("PW", "帕劳");
        COUNTRY_NAME_MAP.put("PN", "皮特凯恩群岛");
        COUNTRY_NAME_MAP.put("TK", "托克劳");
        COUNTRY_NAME_MAP.put("UM", "美国本土外小岛屿");
        COUNTRY_NAME_MAP.put("CX", "圣诞岛");
        COUNTRY_NAME_MAP.put("CC", "科科斯群岛");
        COUNTRY_NAME_MAP.put("NF", "诺福克岛");
        COUNTRY_NAME_MAP.put("GS", "南乔治亚和南桑威奇群岛");

        // 其他特殊情况
        COUNTRY_NAME_MAP.put("COUNTRY NOT SPECIFIED", "未指定国家");
        COUNTRY_NAME_MAP.put("A1", "匿名代理");
        COUNTRY_NAME_MAP.put("A2", "卫星提供商");
        COUNTRY_NAME_MAP.put("O1", "其他国家");

        // 南极洲
        COUNTRY_NAME_MAP.put("AQ", "南极洲");


        // 亚洲
        COUNTRY_NAME_MAP.put("CHINA", "中国");
        COUNTRY_NAME_MAP.put("JAPAN", "日本");
        COUNTRY_NAME_MAP.put("INDIA", "印度");
        COUNTRY_NAME_MAP.put("SOUTH KOREA", "韩国"); // "KOREA, REPUBLIC OF" 标准译名
        COUNTRY_NAME_MAP.put("NORTH KOREA", "朝鲜"); // "KOREA, DEMOCRATIC PEOPLE'S REPUBLIC OF" 标准译名
        COUNTRY_NAME_MAP.put("TURKEY", "土耳其");
        COUNTRY_NAME_MAP.put("SINGAPORE", "新加坡");
        COUNTRY_NAME_MAP.put("LEBANON", "黎巴嫩");
        COUNTRY_NAME_MAP.put("INDONESIA", "印度尼西亚");
        COUNTRY_NAME_MAP.put("THAILAND", "泰国");
        COUNTRY_NAME_MAP.put("PHILIPPINES", "菲律宾");
        COUNTRY_NAME_MAP.put("SAUDI ARABIA", "沙特阿拉伯");
        COUNTRY_NAME_MAP.put("UNITED ARAB EMIRATES", "阿拉伯联合酋长国");
        COUNTRY_NAME_MAP.put("KUWAIT", "科威特");
        COUNTRY_NAME_MAP.put("QATAR", "卡塔尔");
        COUNTRY_NAME_MAP.put("JORDAN", "约旦");
        COUNTRY_NAME_MAP.put("IRAN (ISLAMIC REPUBLIC OF)", "伊朗");
        COUNTRY_NAME_MAP.put("PAKISTAN", "巴基斯坦");
        COUNTRY_NAME_MAP.put("BANGLADESH", "孟加拉国");
        COUNTRY_NAME_MAP.put("SRI LANKA", "斯里兰卡");
        COUNTRY_NAME_MAP.put("CAMBODIA", "柬埔寨");
        COUNTRY_NAME_MAP.put("LAO PEOPLE'S DEMOCRATIC REPUBLIC", "老挝");
        COUNTRY_NAME_MAP.put("MYANMAR", "缅甸");
        COUNTRY_NAME_MAP.put("VIET NAM", "越南");
        COUNTRY_NAME_MAP.put("MALAYSIA", "马来西亚");
        COUNTRY_NAME_MAP.put("BRUNEI DARUSSALAM", "文莱");
        COUNTRY_NAME_MAP.put("OMAN", "阿曼");
        COUNTRY_NAME_MAP.put("BAHRAIN", "巴林");
        COUNTRY_NAME_MAP.put("AFGHANISTAN", "阿富汗");
        COUNTRY_NAME_MAP.put("YEMEN", "也门");
        COUNTRY_NAME_MAP.put("CYPRUS", "塞浦路斯"); // 地理上属于亚洲，但部分国际组织归类为欧洲
        COUNTRY_NAME_MAP.put("GEORGIA", "格鲁吉亚"); // 跨欧亚两洲，通常归为亚洲
        COUNTRY_NAME_MAP.put("KAZAKHSTAN", "哈萨克斯坦");
        COUNTRY_NAME_MAP.put("KYRGYZSTAN", "吉尔吉斯斯坦");
        COUNTRY_NAME_MAP.put("UZBEKISTAN", "乌兹别克斯坦");
        COUNTRY_NAME_MAP.put("TAIWAN, PROVINCE OF CHINA", "中国台湾地区"); // 中国不可分割的一部分
        COUNTRY_NAME_MAP.put("HONG KONG", "中国香港特别行政区");
        COUNTRY_NAME_MAP.put("MACAU", "中国澳门特别行政区");

        // 欧洲
        COUNTRY_NAME_MAP.put("ITALY", "意大利");
        COUNTRY_NAME_MAP.put("FRANCE", "法国");
        COUNTRY_NAME_MAP.put("GERMANY", "德国");
        COUNTRY_NAME_MAP.put("UNITED KINGDOM", "英国");
        COUNTRY_NAME_MAP.put("SWITZERLAND", "瑞士");
        COUNTRY_NAME_MAP.put("NETHERLANDS", "荷兰");
        COUNTRY_NAME_MAP.put("SPAIN", "西班牙");
        COUNTRY_NAME_MAP.put("IRELAND", "爱尔兰");
        COUNTRY_NAME_MAP.put("RUSSIAN FEDERATION", "俄罗斯");
        COUNTRY_NAME_MAP.put("POLAND", "波兰");
        COUNTRY_NAME_MAP.put("BELGIUM", "比利时");
        COUNTRY_NAME_MAP.put("DENMARK", "丹麦");
        COUNTRY_NAME_MAP.put("GREECE", "希腊");
        COUNTRY_NAME_MAP.put("SWEDEN", "瑞典");
        COUNTRY_NAME_MAP.put("PORTUGAL", "葡萄牙");
        COUNTRY_NAME_MAP.put("HUNGARY", "匈牙利");
        COUNTRY_NAME_MAP.put("CZECH REPUBLIC", "捷克");
        COUNTRY_NAME_MAP.put("LITHUANIA", "立陶宛");
        COUNTRY_NAME_MAP.put("ROMANIA", "罗马尼亚");
        COUNTRY_NAME_MAP.put("BULGARIA", "保加利亚");
        COUNTRY_NAME_MAP.put("ESTONIA", "爱沙尼亚");
        COUNTRY_NAME_MAP.put("LATVIA", "拉脱维亚");
        COUNTRY_NAME_MAP.put("SERBIA", "塞尔维亚");
        COUNTRY_NAME_MAP.put("CROATIA (LOCAL NAME: HRVATSKA)", "克罗地亚");
        COUNTRY_NAME_MAP.put("SLOVENIA", "斯洛文尼亚");
        COUNTRY_NAME_MAP.put("SLOVAKIA (SLOVAK REPUBLIC)", "斯洛伐克");
        COUNTRY_NAME_MAP.put("ALBANIA", "阿尔巴尼亚");
        COUNTRY_NAME_MAP.put("ICELAND", "冰岛");
        COUNTRY_NAME_MAP.put("NORWAY", "挪威");
        COUNTRY_NAME_MAP.put("FINLAND", "芬兰");
        COUNTRY_NAME_MAP.put("AUSTRIA", "奥地利");
        COUNTRY_NAME_MAP.put("BELARUS", "白俄罗斯");
        COUNTRY_NAME_MAP.put("UKRAINE", "乌克兰");
        COUNTRY_NAME_MAP.put("MOLDOVA, REPUBLIC OF", "摩尔多瓦");
        COUNTRY_NAME_MAP.put("MONTENEGRO", "黑山");
        COUNTRY_NAME_MAP.put("MACEDONIA, THE FORMER YUGOSLAV REPUBLIC OF", "北马其顿");
        COUNTRY_NAME_MAP.put("BOSNIA AND HERZEGOWINA", "波斯尼亚和黑塞哥维那");
        COUNTRY_NAME_MAP.put("ANDORRA", "安道尔");
        COUNTRY_NAME_MAP.put("MONACO", "摩纳哥");
        COUNTRY_NAME_MAP.put("VATICAN CITY STATE (HOLY SEE)", "梵蒂冈");
        COUNTRY_NAME_MAP.put("LUXEMBOURG", "卢森堡");
        COUNTRY_NAME_MAP.put("SAN MARINO", "圣马力诺");
        COUNTRY_NAME_MAP.put("ISLE OF MAN", "马恩岛");
        COUNTRY_NAME_MAP.put("ALAND ISLANDS", "奥兰群岛");
        COUNTRY_NAME_MAP.put("FAROE ISLANDS", "法罗群岛");
        COUNTRY_NAME_MAP.put("GIBRALTAR", "直布罗陀");

        // 北美洲
        COUNTRY_NAME_MAP.put("UNITED STATES", "美国");
        COUNTRY_NAME_MAP.put("CANADA", "加拿大"); // 修正原数据中的南美洲错误
        COUNTRY_NAME_MAP.put("MEXICO", "墨西哥");
        COUNTRY_NAME_MAP.put("GUATEMALA", "危地马拉");
        COUNTRY_NAME_MAP.put("COSTA RICA", "哥斯达黎加");
        COUNTRY_NAME_MAP.put("TRINIDAD AND TOBAGO", "特立尼达和多巴哥");
        COUNTRY_NAME_MAP.put("PUERTO RICO", "波多黎各");
        COUNTRY_NAME_MAP.put("UNITED STATES MINOR OUTLYING ISLANDS", "美国本土外小岛屿");
        COUNTRY_NAME_MAP.put("JAMAICA", "牙买加");
        COUNTRY_NAME_MAP.put("SAINT KITTS AND NEVIS", "圣基茨和尼维斯");
        COUNTRY_NAME_MAP.put("EL SALVADOR", "萨尔瓦多");
        COUNTRY_NAME_MAP.put("BARBADOS", "巴巴多斯");
        COUNTRY_NAME_MAP.put("HONDURAS", "洪都拉斯");
        COUNTRY_NAME_MAP.put("HAITI", "海地");
        COUNTRY_NAME_MAP.put("DOMINICAN REPUBLIC", "多米尼加共和国");
        COUNTRY_NAME_MAP.put("NICARAGUA", "尼加拉瓜");
        COUNTRY_NAME_MAP.put("MONTSERRAT", "蒙特塞拉特");
        COUNTRY_NAME_MAP.put("CUBA", "古巴");
        COUNTRY_NAME_MAP.put("GRENADA", "格林纳达");
        COUNTRY_NAME_MAP.put("ARUBA", "阿鲁巴");
        COUNTRY_NAME_MAP.put("VIRGIN ISLANDS (U.S.)", "美属维尔京群岛");
        COUNTRY_NAME_MAP.put("BAHAMAS", "巴哈马");
        COUNTRY_NAME_MAP.put("BERMUDA", "百慕大");
        COUNTRY_NAME_MAP.put("CAYMAN ISLANDS", "开曼群岛");
        COUNTRY_NAME_MAP.put("DOMINICA", "多米尼克");
        COUNTRY_NAME_MAP.put("ANTIGUA AND BARBUDA", "安提瓜和巴布达");
        COUNTRY_NAME_MAP.put("BELIZE", "伯利兹");

        // 南美洲
        COUNTRY_NAME_MAP.put("BRAZIL", "巴西");
        COUNTRY_NAME_MAP.put("COLOMBIA", "哥伦比亚");
        COUNTRY_NAME_MAP.put("ARGENTINA", "阿根廷"); // 修正原数据中的北美洲错误
        COUNTRY_NAME_MAP.put("VENEZUELA", "委内瑞拉");
        COUNTRY_NAME_MAP.put("PERU", "秘鲁");
        COUNTRY_NAME_MAP.put("CHILE", "智利");
        COUNTRY_NAME_MAP.put("URUGUAY", "乌拉圭");
        COUNTRY_NAME_MAP.put("BOLIVIA", "玻利维亚");
        COUNTRY_NAME_MAP.put("SURINAME", "苏里南");
        COUNTRY_NAME_MAP.put("GUYANA", "圭亚那");
        COUNTRY_NAME_MAP.put("FRENCH GUIANA", "法属圭亚那");

        // 非洲
        COUNTRY_NAME_MAP.put("SOUTH AFRICA", "南非"); // 修正原数据中的南美洲错误
        COUNTRY_NAME_MAP.put("ALGERIA", "阿尔及利亚");
        COUNTRY_NAME_MAP.put("EGYPT", "埃及");
        COUNTRY_NAME_MAP.put("TUNISIA", "突尼斯");
        COUNTRY_NAME_MAP.put("MOROCCO", "摩洛哥");
        COUNTRY_NAME_MAP.put("NIGERIA", "尼日利亚");
        COUNTRY_NAME_MAP.put("KENYA", "肯尼亚");
        COUNTRY_NAME_MAP.put("BOTSWANA", "博茨瓦纳");
        COUNTRY_NAME_MAP.put("CONGO", "刚果共和国");
        COUNTRY_NAME_MAP.put("CONGO, THE DEMOCRATIC REPUBLIC OF THE", "刚果民主共和国");
        COUNTRY_NAME_MAP.put("COTE D'IVOIRE", "科特迪瓦");
        COUNTRY_NAME_MAP.put("BURKINA FASO", "布基纳法索");
        COUNTRY_NAME_MAP.put("TOGO", "多哥");
        COUNTRY_NAME_MAP.put("UGANDA", "乌干达");
        COUNTRY_NAME_MAP.put("LIBERIA", "利比里亚");
        COUNTRY_NAME_MAP.put("SENEGAL", "塞内加尔");
        COUNTRY_NAME_MAP.put("GHANA", "加纳");
        COUNTRY_NAME_MAP.put("GABON", "加蓬");
        COUNTRY_NAME_MAP.put("CAMEROON", "喀麦隆");
        COUNTRY_NAME_MAP.put("BENIN", "贝宁");
        COUNTRY_NAME_MAP.put("MAURITIUS", "毛里求斯");
        COUNTRY_NAME_MAP.put("MADAGASCAR", "马达加斯加");
        COUNTRY_NAME_MAP.put("TANZANIA, UNITED REPUBLIC OF", "坦桑尼亚");
        COUNTRY_NAME_MAP.put("RWANDA", "卢旺达");
        COUNTRY_NAME_MAP.put("BURUNDI", "布隆迪");
        COUNTRY_NAME_MAP.put("LESOTHO", "莱索托");
        COUNTRY_NAME_MAP.put("SWAZILAND", "斯威士兰"); // 现称 "ESWATINI"，但保留原映射
        COUNTRY_NAME_MAP.put("NAMIBIA", "纳米比亚");
        COUNTRY_NAME_MAP.put("ZAMBIA", "赞比亚");
        COUNTRY_NAME_MAP.put("ZIMBABWE", "津巴布韦");
        COUNTRY_NAME_MAP.put("SUDAN", "苏丹");
        COUNTRY_NAME_MAP.put("LIBYAN ARAB JAMAHIRIYA", "利比亚");
        COUNTRY_NAME_MAP.put("ERITREA", "厄立特里亚"); // 原数据未包含，补充常见国家
        COUNTRY_NAME_MAP.put("ETHIOPIA", "埃塞俄比亚");
        COUNTRY_NAME_MAP.put("DJIBOUTI", "吉布提"); // 原数据未包含，补充常见国家

        // 大洋洲
        COUNTRY_NAME_MAP.put("AUSTRALIA", "澳大利亚");
        COUNTRY_NAME_MAP.put("NEW ZEALAND", "新西兰");
        COUNTRY_NAME_MAP.put("FIJI", "斐济");
        COUNTRY_NAME_MAP.put("PAPUA NEW GUINEA", "巴布亚新几内亚"); // 修正原数据中的非洲错误
        COUNTRY_NAME_MAP.put("NEW CALEDONIA", "新喀里多尼亚");
        COUNTRY_NAME_MAP.put("MICRONESIA, FEDERATED STATES OF", "密克罗尼西亚联邦");
        COUNTRY_NAME_MAP.put("SAMOA", "萨摩亚");
        COUNTRY_NAME_MAP.put("AMERICAN SAMOA", "美属萨摩亚");
        COUNTRY_NAME_MAP.put("TONGA", "汤加");
        COUNTRY_NAME_MAP.put("COOK ISLANDS", "库克群岛");
        COUNTRY_NAME_MAP.put("NIUE", "纽埃");
        COUNTRY_NAME_MAP.put("VANUATU", "瓦努阿图");
        COUNTRY_NAME_MAP.put("PALAU", "帕劳");
        COUNTRY_NAME_MAP.put("MARSHALL ISLANDS", "马绍尔群岛");
        COUNTRY_NAME_MAP.put("NORFOLK ISLAND", "诺福克岛");
        COUNTRY_NAME_MAP.put("TOKELAU", "托克劳");
        COUNTRY_NAME_MAP.put("WALLIS AND FUTUNA ISLANDS", "瓦利斯和富图纳");
        COUNTRY_NAME_MAP.put("KIRIBATI", "基里巴斯");

        // 特殊地区/组织
        COUNTRY_NAME_MAP.put("EUROPEAN UNION", "欧洲联盟");
        COUNTRY_NAME_MAP.put("PALESTINIAN TERRITORY, OCCUPIED", "巴勒斯坦地区");
        COUNTRY_NAME_MAP.put("SOUTH GEORGIA AND THE SOUTH SANDWICH ISLANDS", "南乔治亚和南桑威奇群岛");
        COUNTRY_NAME_MAP.put("ANTARCTICA", "南极洲"); // 原数据中的 "SVALBARD AND JAN MAYEN ISLANDS" 属欧洲，此处修正


    }

    public void getDrug(String filePath, String databaseName, HttpServletResponse response) {
        // 读取文件中的String
        String filePathAll = filePath;
        StringBuilder dataBuilder = new StringBuilder();

        try (BufferedReader br = new BufferedReader(new FileReader(filePathAll))) {
            String line;
            while ((line = br.readLine()) != null) {
                dataBuilder.append(line).append("\n");
            }
        } catch (IOException e) {
            System.err.println("读取文件时出现错误: " + e.getMessage());
            write("读取文件时出现错误: " + e.getMessage(), response);
            return;
        }

        String data = dataBuilder.toString();

        String[] lines = data.split("\n");
        if (lines.length == 0) {
            throw new IllegalArgumentException("数据为空");
        }

        String[] headers = lines[0].split("\\$");
        int batchSize = 1000;
        List<Document> documents = new ArrayList<>(batchSize);

        for (int i = 1; i < lines.length; i++) {
            String[] values = lines[i].split("\\$");


            Document doc = new Document();
            for (int j = 0; j < headers.length; j++) {
                try {
                    doc.append(headers[j], values[j]);
                } catch (ArrayIndexOutOfBoundsException e) {
                    if (j == headers.length - 1) {
                        doc.append(headers[j], "");
                    }
                }

            }
            documents.add(doc);

            if (documents.size() == batchSize) {
                insertDocuments(documents, databaseName);
                write("数据插入成功！已插入条数:" + i + "条数据", response);
                documents.clear();
            }

        }

        // 插入剩余数据
        if (!documents.isEmpty()) {
            insertDocuments(documents, databaseName);
        }
    }


    private void insertDocuments(List<Document> documents, String databaseName) {
        try {
            MongoTemplate database = mongoUtil.mongo;
            database.insert(documents, databaseName);
            System.out.println("数据插入成功！");
        } catch (Exception e) {
            System.err.println("插入数据时出现错误: " + e.getMessage());
        }
    }


    public void write(String value, HttpServletResponse response) {
        try {

            response.setContentType("text/event-stream");
            response.setCharacterEncoding("UTF-8");
            response.setHeader("Cache-Control", "no-cache");
            if (Objects.nonNull(value)) {
                value = value.replaceAll("\n", "\\\\n");
                //需要data: 开头
                response.getWriter().write("data: " + value + "\n\n");
                response.getWriter().flush();
                return;
            }

            Thread.sleep(1);
        } catch (IOException | InterruptedException e) {
            log.error("Error occurred: " + e.getMessage());
        }
    }


    //异步调用
    @Override
    @Async
    public void writeEs(List<String> years) {
        // 准备常量和模板对象，避免重复创建
        for (String year : years) {
        final String demoCollection = "DEMOOnly" + year;
        final DateTimeFormatter dateFormatter = new DateTimeFormatterBuilder()
                .appendPattern("yyyyMMdd")
                .parseStrict()
                .toFormatter();

        long count = mongoUtil.mongo.count(new Query(), JSONObject.class, demoCollection);
        int pages = (int) (count % 1000 == 0 ? count / 1000 : count / 1000 + 1);

        for (int i = 0; i < pages; i++) {
            // 使用预设容量初始化集合，减少扩容开销
            List<AdverseIndex> adverseIndices = new ArrayList<>(1000);
            List<AdverseForCaseIndex> adverseForCaseIndices = new ArrayList<>(1000);

            // 批量查询主数据
            List<JSONObject> results = mongoUtil.mongo.find(
                    new Query().skip(i * 1000).limit(1000),
                    JSONObject.class,
                    demoCollection
            );

            for (JSONObject result : results) {
                String caseid = result.getString("caseid");
                String primaryid = result.getString("primaryid");
                String table = result.getString("table");

                // 构建查询条件（只构建一次）
                Criteria criteria = buildPrimaryIdCriteria(primaryid);
                Query query = new Query(criteria);

                // 批量查询相关数据
                List<JSONObject> drugList = mongoUtil.mongo.find(query, JSONObject.class, "DRUG" + table);
                List<JSONObject> reacList = mongoUtil.mongo.find(query, JSONObject.class, "REAC" + table);
                List<JSONObject> outcList = mongoUtil.mongo.find(query, JSONObject.class, "OUTC" + table);
                List<JSONObject> therList = mongoUtil.mongo.find(query, JSONObject.class, "THER" + table);
                List<JSONObject> indiList = mongoUtil.mongo.find(query, JSONObject.class, "INDI" + table);

                // 处理不良反应列表
                List<String> ptList = processPtList(reacList);
                long ptListNum = ptList.size();

                // 处理严重不良反应结局
                List<String> outcCodList = processOutcList(outcList);
                List<String> outcomeCod = getOUTC(outcCodList);
                long outcomeCodNum = outcCodList.size();

                // 处理年龄
                String age = getValueIgnoreCase(result, "AGE");
                String ageCode = getValueIgnoreCase(result, "AGE_COD");
                String convertedAge = ageConvert(age, ageCode);

                // 处理性别
                String sex = getValueIgnoreCase(result, "GNDR_COD");
                if (StringUtils.isEmpty(sex)) {
                    sex = getValueIgnoreCase(result, "sex");
                }
                sex = convertSex(sex);

                // 处理职业
                String occpCod = getValueIgnoreCase(result, "OCCP_COD");
                String occupationalCod = getOccupationalCod(occpCod);

                // 处理日期
                String date = getValueIgnoreCase(result, "FDA_DT");
                Integer dateInt = StringUtils.isNotEmpty(date) ? Integer.valueOf(date) : null;

                // 处理体重
                String weight = getValueIgnoreCase(result, "WT");
                String weightCode = getValueIgnoreCase(result, "WT_COD");
                String convertedWeight = weightConvert(weight, weightCode);

                // 处理地区
                String reporterCountry = getValueIgnoreCase(result, "REPORTER_COUNTRY");
                String countryContinent = "未知";
                String countryName = "未知";
                if (StringUtils.isNotEmpty(reporterCountry)) {
                    countryContinent = COUNTRY_CONTINENT_MAP.getOrDefault(reporterCountry, "未知");
                    countryName = COUNTRY_NAME_MAP.getOrDefault(reporterCountry, "未知");
                }

                // 处理事件日期
                String eventDt = getValueIgnoreCase(result, "EVENT_DT");

                // 创建主索引对象
                String id = year + caseid;
                AdverseIndex adverseIndex = new AdverseIndex();
                adverseIndex.setId(id);
                adverseIndex.setPtList(ptList);
                adverseIndex.setPtListNum(ptListNum);
                adverseIndex.setAge(convertedAge);
                adverseIndex.setSex(sex);
                adverseIndex.setOccupationalCod(occupationalCod);
                adverseIndex.setOutcomeCod(outcomeCod);
                adverseIndex.setDate(dateInt);
                adverseIndex.setOutcomeCodNum(outcomeCodNum);
                adverseIndex.setWeight(convertedWeight);
                adverseIndex.setReporterCountry(countryContinent);
                adverseIndex.setReporterCountryName(countryName);
                adverseIndex.setSingleDrug(drugList.size() <= 1);
                adverseIndex.setYear(Integer.valueOf(year));

                // 准备药品相关集合
                List<String> drugNames = new ArrayList<>(drugList.size());
                List<String> prodAis = new ArrayList<>(drugList.size());
                List<String> roleCods = new ArrayList<>(drugList.size());
                List<RoleCod> realRoleCods = new ArrayList<>(drugList.size());
                List<String> routeList = new ArrayList<>(drugList.size());
                List<String> doseAmtCombineList = new ArrayList<>(drugList.size());
                List<String> doseFormList = new ArrayList<>(drugList.size());
                List<String> indicationPtList = new ArrayList<>(drugList.size());

                // 处理每个药品
                for (JSONObject drug : drugList) {
                    AdverseForCaseIndex caseIndex = new AdverseForCaseIndex();
                    RoleCod roleCod = new RoleCod();

                    // 处理药品名称和相关信息
                    String drugName = getValueIgnoreCase(drug, "DRUGNAME");
                    drugName = StringUtils.isNotEmpty(drugName) ? drugName.toLowerCase() : "";

                    String prodAi = getValueIgnoreCase(drug, "prod_ai");
                    prodAi = StringUtils.isNotEmpty(prodAi) ? prodAi.toLowerCase() : "";

                    String roleCodStr = getValueIgnoreCase(drug, "role_cod");

                    // 设置药品基本信息
                    drugNames.add(drugName);
                    prodAis.add(prodAi);
                    roleCods.add(drugName + "￥" + prodAi + "￥" + roleCodStr);

                    // 设置RoleCod信息
                    roleCod.setDrug(drugName);
                    roleCod.setProdAi(prodAi);
                    roleCod.setRole(roleCodStr);
                    roleCod.setRechal(getValueIgnoreCase(drug, "rechal"));
                    roleCod.setDechal(getValueIgnoreCase(drug, "dechal"));
                    caseIndex.setRechal(getValueIgnoreCase(drug, "rechal"));
                    caseIndex.setDechal(getValueIgnoreCase(drug, "dechal"));

                    // 设置案例索引基本信息
                    caseIndex.setYear(Integer.valueOf(year));
                    caseIndex.setDrugName(drugName);
                    caseIndex.setProdAi(prodAi);
                    caseIndex.setRoleCod(roleCodStr);


                    // 处理治疗持续时间和反应时间
                    String drugSeq = getValueIgnoreCase(drug, "DRUG_SEQ");
                    processDurationAndReactionTime(
                            therList, drugSeq, eventDt,
                            roleCod, adverseIndex, caseIndex,
                            dateFormatter
                    );

                    // 处理用法用量等信息
                    processDrugAdministration(drug, indiList, drugSeq,
                            routeList, doseAmtCombineList, doseFormList,
                            indicationPtList, caseIndex);

                    // 设置其他共用信息
                    caseIndex.setPtList(ptList);
                    caseIndex.setPtListNum(ptListNum);
                    caseIndex.setOutcomeCod(outcomeCod);
                    caseIndex.setOutcomeCodNum(outcomeCodNum);
                    caseIndex.setReporterCountry(countryContinent);
                    caseIndex.setOccupationalCod(occupationalCod);
                    caseIndex.setSex(sex);
                    caseIndex.setAge(convertedAge);
                    caseIndex.setWeight(convertedWeight);
                    caseIndex.setDate(dateInt);

                    // 添加到集合
                    adverseForCaseIndices.add(caseIndex);
                    realRoleCods.add(roleCod);
                }

                // 完成主索引对象设置
                adverseIndex.setRoleCods(realRoleCods);
                adverseIndex.setDrugName(drugNames);
                adverseIndex.setProdAi(prodAis);
                adverseIndex.setRoleCod(roleCods);
                adverseIndex.setIndicationPt(indicationPtList);
                adverseIndex.setRoute(routeList);
                adverseIndex.setDoseAmtCombine(doseAmtCombineList);
                adverseIndex.setDoseForm(doseFormList);

                adverseIndices.add(adverseIndex);
            }

            // 批量保存到ES
            saveToEs(adverseIndices, year, i);
            saveToEs(adverseForCaseIndices, year, i);

            if (i % 10 == 0) {
                System.out.println(year + "年" + i * 1000 + "条数据写入完成");
            }
        }
        log.info("写入" + year + "年数据成功");
        }
    }

    // 构建主键查询条件
    private Criteria buildPrimaryIdCriteria(String primaryid) {
        Criteria criteria = new Criteria();
        try {
            Long primaryIdLong = Long.parseLong(primaryid);
            criteria.orOperator(
                    Criteria.where("ISR").is(primaryid),
                    Criteria.where("primaryid").is(primaryid),
                    Criteria.where("ISR").is(primaryIdLong),
                    Criteria.where("primaryid").is(primaryIdLong)
            );
        } catch (NumberFormatException e) {
            criteria.orOperator(
                    Criteria.where("ISR").is(primaryid),
                    Criteria.where("primaryid").is(primaryid)
            );
        }
        return criteria;
    }

    // 处理不良反应列表
    private List<String> processPtList(List<JSONObject> reacList) {
        List<String> ptList = new ArrayList<>(reacList.size());
        for (JSONObject json : reacList) {
            String pt = getValueIgnoreCase(json, "pt");
            ptList.add(StringUtils.isNotEmpty(pt) ? pt.toLowerCase() : "");
        }
        return ptList;
    }

    // 处理严重不良反应结局列表
    private List<String> processOutcList(List<JSONObject> outcList) {
        List<String> outcListResult = new ArrayList<>(outcList.size());
        for (JSONObject json : outcList) {
            String outcCod = getValueIgnoreCase(json, "OUTC_COD");
            if (StringUtils.isNotEmpty(outcCod)) {
                outcListResult.add(outcCod);
            }
        }
        return outcListResult;
    }

    // 忽略大小写获取JSON属性值
    private String getValueIgnoreCase(JSONObject json, String key) {
        String value = json.getString(key);
        if (StringUtils.isEmpty(value)) {
            value = json.getString(key.toLowerCase());
        }
        return value;
    }

    // 转换性别
    private String convertSex(String sex) {
        if ("F".equals(sex)) {
            return "女";
        } else if ("M".equals(sex)) {
            return "男";
        } else {
            return "未知";
        }
    }

    // 处理治疗持续时间和反应时间
    private void processDurationAndReactionTime(
            List<JSONObject> therList, String drugSeq, String eventDt,
            RoleCod roleCod, AdverseIndex adverseIndex,
            AdverseForCaseIndex caseIndex, DateTimeFormatter formatter) {

        // 默认为unknown
        String dur = "unknown";
        String dur2 = "unknown";
        String reactionTime = "unknown";
        String reactionTime2 = "unknown";

        // 查找对应的治疗记录
        JSONObject therJson = findTherJsonByDrugSeq(therList, drugSeq);
        if (therJson != null) {
            String startDt = getValueIgnoreCase(therJson, "START_DT");
            String endDt = getValueIgnoreCase(therJson, "END_DT");

            // 计算治疗持续时间
            if (StringUtils.isNotEmpty(startDt) && StringUtils.isNotEmpty(endDt)) {
                dur = calculateDateDiff(startDt, endDt, formatter);
                dur2 = calculateDateDiff2(startDt, endDt, formatter);
            }

            // 计算反应时间
            if (StringUtils.isNotEmpty(eventDt) && StringUtils.isNotEmpty(startDt)) {
                reactionTime = calculateDateDiff(startDt, eventDt, formatter);
                reactionTime2 = calculateDateDiff2(startDt, eventDt, formatter);
            }
        }

        // 设置计算结果
        roleCod.setDur(dur);
        roleCod.setReactionOfTime(reactionTime);
        adverseIndex.setDur(dur);
        adverseIndex.setReactionOfTime(reactionTime);
        caseIndex.setDur(dur);
        caseIndex.setReactionOfTime(reactionTime);

        roleCod.setDur2(dur2);
        roleCod.setReactionOfTime2(reactionTime2);
        adverseIndex.setDur2(dur2);
        adverseIndex.setReactionOfTime2(reactionTime2);
        caseIndex.setDur(dur2);
        caseIndex.setReactionOfTime(reactionTime2);
    }

    // 根据drugSeq查找治疗记录
    private JSONObject findTherJsonByDrugSeq(List<JSONObject> therList, String drugSeq) {
        if (CollUtil.isEmpty(therList) || StringUtils.isEmpty(drugSeq)) {
            return null;
        }

        for (JSONObject json : therList) {
            if (drugSeq.equals(getValueIgnoreCase(json, "DRUG_SEQ")) ||
                    drugSeq.equals(getValueIgnoreCase(json, "dsg_drug_seq"))) {
                return json;
            }
        }
        return null;
    }

    // 计算日期差
    private String calculateDateDiff(String startDt, String endDt, DateTimeFormatter formatter) {
        try {
            // 补全日期格式
            String start = completeDate(startDt);
            String end = completeDate(endDt);

            LocalDate startDate = LocalDate.parse(start, formatter);
            LocalDate endDate = LocalDate.parse(end, formatter);

            long days = ChronoUnit.DAYS.between(startDate, endDate) + 1;
            return days + "days";
        } catch (Exception e) {
            return "unknown";
        }
    }

    private String calculateDateDiff2(String startDt, String endDt, DateTimeFormatter formatter) {
        try {
            // 补全日期格式
            String start = completeDate(startDt);
            String end = completeDate(endDt);

            LocalDate startDate = LocalDate.parse(start, formatter);
            LocalDate endDate = LocalDate.parse(end, formatter);

            long days = ChronoUnit.DAYS.between(startDate, endDate) + 1;
            if (days <= 1){
                return "1days";
            }else if (days <= 7){
                return "7days";
            }else if (days <= 30){
                return "30days";
            }else if (days <= 90){
                return "90days";
            }else if (days <= 180){
                return "180days";
            }else if (days <= 365){
                return "365days";
            }else {
                return "多于一年";
            }
        } catch (Exception e) {
            return "unknown";
        }
    }

    // 补全日期格式为8位
    private String completeDate(String date) {
        if (StringUtils.isEmpty(date)) {
            return "";
        }

        if (date.length() == 4) {
            return date + "1231"; // 年份补全为12月31日
        } else if (date.length() == 6) {
            // 补全为当月最后一天
            String year = date.substring(0, 4);
            String month = date.substring(4, 6);
            int yearInt = Integer.parseInt(year);
            int monthInt = Integer.parseInt(month);

            LocalDate lastDay = LocalDate.of(yearInt, monthInt, 1)
                    .withDayOfMonth(LocalDate.of(yearInt, monthInt, 1).lengthOfMonth());
            return lastDay.format(DateTimeFormatter.BASIC_ISO_DATE);
        } else if (date.length() == 7) {
            return date + "01"; // 特殊情况处理，补全为当月1日
        }
        return date;
    }

    // 处理药品用法用量等信息
    private void processDrugAdministration(
            JSONObject drug, List<JSONObject> indiList, String drugSeq,
            List<String> routeList, List<String> doseAmtCombineList,
            List<String> doseFormList, List<String> indicationPtList,
            AdverseForCaseIndex caseIndex) {

        // 处理用法
        String route = getValueIgnoreCase(drug, "ROUTE");
        route = StringUtils.isNotEmpty(route) ? route.toLowerCase() : "unknown";
        routeList.add(route);
        caseIndex.setRoute(route);

        // 处理剂量
        String doseAmt = getValueIgnoreCase(drug, "dose_amt");
        String doseUnit = getValueIgnoreCase(drug, "dose_unit");
        String doseAmtCombine = (StringUtils.isNotEmpty(doseAmt) && StringUtils.isNotEmpty(doseUnit))
                ? doseAmt + doseUnit : "unknown";
        doseAmtCombineList.add(doseAmtCombine);
        caseIndex.setDoseAmtCombine(doseAmtCombine);

        // 处理剂型
        String doseForm = getValueIgnoreCase(drug, "dose_form");
        doseForm = StringUtils.isNotEmpty(doseForm) ? doseForm : "unknown";
        doseFormList.add(doseForm);
        caseIndex.setDoseForm(doseForm);

        // 处理适应症
        String indicationPt = processIndicationPt(indiList, drugSeq);
        indicationPtList.add(indicationPt);
        caseIndex.setIndicationPt(indicationPt);
    }

    // 处理适应症
    private String processIndicationPt(List<JSONObject> indiList, String drugSeq) {
        if (CollUtil.isEmpty(indiList) || StringUtils.isEmpty(drugSeq)) {
            return "";
        }

        for (JSONObject json : indiList) {
            if (drugSeq.equals(getValueIgnoreCase(json, "DRUG_SEQ")) ||
                    drugSeq.equals(getValueIgnoreCase(json, "indi_drug_seq"))) {

                String indiPt = getValueIgnoreCase(json, "INDI_PT");
                return StringUtils.isNotEmpty(indiPt) ? indiPt.toLowerCase() : "";
            }
        }
        return "";
    }

    // 保存到ES并处理异常
    private <T> void saveToEs(List<T> list, String year, int page) {
        if (CollUtil.isEmpty(list)) {
            return;
        }

        try {
            elasticsearchRestTemplate.save(list);
        } catch (Exception e) {
            try {
                // 重试一次
                elasticsearchRestTemplate.save(list);
            } catch (Exception ex) {
                log.error(ex.getMessage(), ex);
                log.error(year + "年" + page * 1000 + "条数据写入失败");
            }
        }
    }

    private String weightConvert(String weight, String weightCode) {
        double i;
        try {
            i = Double.parseDouble(weight);
        } catch (Exception e) {
            return "未知";
        }

        if (StringUtils.isEmpty(weight) || StringUtils.isEmpty(weightCode)) {
            return "未知";
        }
        if ("KG".equals(weightCode)) {
            if (i < 50) {
                return "<50kg";
            }
            if (i >= 50 && i <= 100) {
                return "50~100kg";
            }
            if (i > 100) {
                return ">100kg";
            }
        }
        if ("LBS".equals(weightCode)) {
            if (i < 110) {
                return "<50kg";
            }
            if (i >= 110 && i <= 220) {
                return "50~100kg";
            }
            if (i > 220) {
                return ">100kg";
            }
        }
        return "未知";
    }

    private List<String> getOUTC(List<String> strings1) {
        if (CollUtil.isEmpty(strings1)) {
            ArrayList<String> strings = new ArrayList<String>();
            return strings;
        }
        ArrayList<String> strings = new ArrayList<>();
        if (strings1.contains("DE")) {
            strings.add("死亡");
            return strings;
        }
        if (strings1.contains("LT")) {
            strings.add("危及生命");
            return strings;
        }
        if (strings1.contains("DS")) {
            strings.add("残疾");
            return strings;
        }
        if (strings1.contains("CA")) {
            strings.add("先天性畸形");
            return strings;
        }
        if (strings1.contains("RI")) {
            strings.add("需要临床干预以防止永久性损伤/损坏");
            return strings;
        }
        if (strings1.contains("HO")) {
            strings.add("需要住院治疗或延长住院时间");
            return strings;
        }
        if (strings1.contains("OT")) {
            strings.add("其他重要的医学事件");
            return strings;
        }
        return strings;
    }

    private String getOccupationalCod(String string) {
        if (StringUtils.isEmpty(string)) {
            return "未知";
        }

        if (string.equals("MD")) {
            return "医生";
        }
        if (string.equals("PH")) {
            return "药剂师";
        }
        if (string.equals("OT")) {
            return "其他";
        }
        if (string.equals("LW")) {
            return "律师";
        }
        if (string.equals("CN")) {
            return "消费者";
        }
        return "未知";

    }


    //年龄转化
    private String ageConvert(String num, String unit) {
        double num1 = 0;
        try {
            num1 = Double.parseDouble(num);
        } catch (Exception e) {
            return "未知";
        }
        double age = 0;
        if (StringUtils.isEmpty(num) || StringUtils.isEmpty(unit)) {
            return "未知";
        }
        if (unit.equals("YR")) {
            age = num1;
        }
        if (unit.equals("DEC")) {
            age = num1 * 10;
        }
        if (unit.equals("MON")) {
            age = num1 / 12;
        }
        if (unit.equals("DAY")) {
            age = num1 / 365;
        }
        if (unit.equals("WK")) {
            age = num1 / 52;
        }
        if (unit.equals("HR")) {
            age = num1 / 8760;
        }
        if (age <= 18) {
            return "≤18岁";
        }
        if (age >= 65) {
            return "≥65岁";
        }
        if (age > 18 && age < 65) {
            return "18<年龄<65";
        }
        return "未知";
    }


    private void writeEs1(String year) {


    }

    private void writeEs2(String year) {

    }


}




