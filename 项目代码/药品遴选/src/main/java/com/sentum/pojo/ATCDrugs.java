package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * atc药品表，用于检索中英文对照及同类药物推荐
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("super_manual_atc_drugs")
public class ATCDrugs {
    /**
     * 唯一id
     */
    private String id;
    /**
     * 标准英文名称
     */
    private String englishName;
    /**
     * 英文同义词
     */
    private List<String> englishSynonym;
    /**
     * 标准英文名称
     */
    private String chineseName;
    /**
     * 英文同义词
     */
    private List<String> chineseSynonym;
    /**
     * 同类药物推荐的id集合
     */
    private List<String> similarIds;
}
