class CustomException extends Error{
    constructor(message,body){
        super(body);

    this.message=message;
    this.body=body;
    }
    
}

module.exports=CustomException