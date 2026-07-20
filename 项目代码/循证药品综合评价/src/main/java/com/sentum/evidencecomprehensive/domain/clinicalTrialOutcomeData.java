package com.sentum.evidencecomprehensive.domain;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import lombok.Data;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;
import java.util.Map;

/**
 * 临床试验mongo对应实体类--clinicalTrial
 * @author zgm
 */
@Data
@Document("ctg_studies")
public class clinicalTrialOutcomeData {
    @Id
    private String id;
    
    /**
     * 
     */
    @Field("NCT Number")
    private String nctNumber;

    /**
     *
     */
    @Field("Study Title")
    private String studyTitle;

    /**
     *
     */
    @Field("data_list")
    private JSONArray dataList;

    @Field("translated_data_list")
    private JSONArray translatedDataList;
}
