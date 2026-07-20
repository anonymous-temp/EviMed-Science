package com.sentum.drugsafe.pojo;

import lombok.Data;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 药名说明书VO
 *
 * @author zgm
 */
@Document("drug_instruction_words")
@Data
public class DrugInstructionWords {
    private String id;
    /**
     * 五级编码
     ***/
    private String code;
    /**
     * 五级英文
     ***/
    private String englishName;
    /**
     * 英文同义词(包含五级英文、英文同义词)
     ***/
    private List<String> englishWords;
    /**
     * 五级中文
     ***/
    private String genericName;
    /**
     * 中文同义词(包含五级中文、中文同义词)
     ***/
    private List<String> genericWords;
    /**
     * NMPA说明书
     ***/
    private String nmpaName;
    /**
     * NMPA说明书同义词(包含NMPA说明书、NMPA说明书同义词、NMPA商品名)
     ***/
    private List<String> nmpaWords;
}
